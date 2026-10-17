import SwiftUI
import UIKit

/// The chat, for SwiftUI. It stays mounted while the terminal is shown, hidden, so that going back
/// finds it as it was.
struct ChatScreen: UIViewRepresentable {
    let session: ChatSession
    let shown: Bool
    /// What the agent waits on, as the chat's last row.
    let wait: ChatWait?
    /// A tool's row was tapped.
    let openTool: (ToolUse) -> Void

    func makeUIView(context: Context) -> ChatView {
        let view = ChatView()
        view.session = session
        session.view = view
        return view
    }

    func updateUIView(_ view: ChatView, context: Context) {
        view.isHidden = !shown
        view.openTool = openTool
        view.showWait(wait)
    }

    static func dismantleUIView(_ view: ChatView, coordinator: ()) {
        if view.session?.view === view {
            view.session?.view = nil
        }
    }
}

/// What one place in the chat shows: a row, the note of why the chat is told no more, or what the
/// agent waits on.
enum ChatItem {
    case row(ChatRow)
    case note(String)
    case wait(AnyView)
}

/// What the agent waits on, drawn as the chat's last row: drawn again when the wait changes.
struct ChatWait {
    let waiting: Waiting
    let card: AnyView
}

/// What an agent and the person said to each other (design §5.4, P7): a list that only grows, a row
/// per entry, read from the session's log, and what the agent waits on last. A table view keeps its
/// rows' heights one by one, so a telling inserts the rows that are new and draws again the few that
/// changed, measures only the rows in sight, and lays out nothing else again. It is drawn from the
/// bottom up: rows fewer than a screenful sit at its bottom, and a view made shorter (the keyboard)
/// loses room at its top, so what the person reads stays. It follows the newest row until the person
/// scrolls up. SwiftUI draws each row (`ChatRowView`), and markdown's inline styles with it.
final class ChatView: UIView, UITableViewDataSource, UITableViewDelegate {
    /// Where the rows are read from.
    weak var session: ChatSession?
    /// A tool's row was tapped.
    var openTool: ((ToolUse) -> Void)?

    private static let reuse = "row"
    /// The room above the first row and under the last.
    private static let gap: CGFloat = 8
    private let list = ChatList(frame: .zero, style: .plain)
    private let newest: UIButton
    private let empty = UILabel()
    private var wait: ChatWait? = nil
    private var following = true {
        didSet { newest.isHidden = following }
    }
    private var settling = false

    init() {
        var look = UIButton.Configuration.filled()
        look.image = UIImage(systemName: "arrow.down.to.line")
        look.cornerStyle = .capsule
        look.baseBackgroundColor = Tones.text
        look.baseForegroundColor = Tones.onPrimary
        newest = UIButton(configuration: look)
        super.init(frame: .zero)

        backgroundColor = Tones.background
        list.backgroundColor = Tones.background
        list.dataSource = self
        list.delegate = self
        list.separatorStyle = .none
        list.rowHeight = UITableView.automaticDimension
        list.estimatedRowHeight = 64
        list.contentInsetAdjustmentBehavior = .never
        list.contentInset = UIEdgeInsets(top: Self.gap, left: 0, bottom: Self.gap, right: 0)
        list.register(UITableViewCell.self, forCellReuseIdentifier: Self.reuse)
        list.contentSizeChanged = { [weak self] in self?.settle() }
        addSubview(list)

        empty.text = "Nothing said yet"
        empty.textColor = Tones.tertiary
        empty.font = .preferredFont(forTextStyle: .callout)
        empty.textAlignment = .center
        list.backgroundView = empty

        newest.accessibilityLabel = "Back to the newest"
        newest.isHidden = true
        newest.addAction(UIAction { [weak self] _ in self?.jumpToNewest() }, for: .primaryActionTriggered)
        addSubview(newest)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let before = list.frame.size
        list.frame = bounds
        let size = newest.intrinsicContentSize
        newest.frame = CGRect(
            x: bounds.maxX - size.width - 16, y: bounds.maxY - size.height - 16,
            width: size.width, height: size.height)
        guard before != bounds.size else { return }
        settle()
        if following {
            scrollToNewest(animated: false)
        } else {
            // The bottom stays where it was on the screen: the room was taken from the top, or given there.
            let highest = -list.contentInset.top
            let lowest = max(highest, list.contentSize.height + list.contentInset.bottom - bounds.height)
            let y = list.contentOffset.y + before.height - bounds.height
            list.contentOffset.y = min(max(y, highest), lowest)
        }
    }

    /// Rows fewer than a screenful sit at its bottom, the room above them.
    private func settle() {
        guard !settling else { return }
        settling = true
        defer { settling = false }
        let top = max(Self.gap, list.bounds.height - list.contentSize.height - Self.gap)
        guard abs(list.contentInset.top - top) > 0.5 else { return }
        list.contentInset.top = top
        if following {
            list.contentOffset.y = max(-top, list.contentSize.height + list.contentInset.bottom - list.bounds.height)
        }
    }

    // MARK: What the session tells

    /// Shows the log afresh: when the chat is attached, and when the conversation is told anew.
    func reload() {
        list.reloadData()
        // The list takes the new count now, so that the next telling's inserts start from it.
        _ = list.numberOfRows(inSection: 0)
        showEmpty()
        if following { scrollToNewest(animated: false) }
    }

    /// One telling, as the log took it.
    func apply(_ change: ChatLog.Change) {
        if change.reset {
            reload()
            return
        }
        if !change.updated.isEmpty {
            list.reconfigureRows(at: Self.paths(change.updated))
        }
        if !change.appended.isEmpty {
            list.insertRows(at: Self.paths(Array(change.appended)), with: .none)
        }
        showEmpty()
        if following { scrollToNewest(animated: false) }
    }

    /// The note of why the chat is told no more, after the last row.
    func noteAdded() {
        guard let log = session?.log else { return }
        list.insertRows(at: [IndexPath(row: log.rows.count, section: 0)], with: .none)
        showEmpty()
        if following { scrollToNewest(animated: false) }
    }

    /// What the agent waits on, the last row; nil while it waits on nothing.
    func showWait(_ wait: ChatWait?) {
        let before = self.wait
        self.wait = wait
        let last = list.numberOfRows(inSection: 0)
        switch (before, wait) {
        case (nil, nil):
            return
        case (nil, .some):
            list.insertRows(at: [IndexPath(row: last, section: 0)], with: .none)
        case (.some, nil):
            list.deleteRows(at: [IndexPath(row: last - 1, section: 0)], with: .none)
        case (.some(let old), .some(let new)):
            guard old.waiting != new.waiting else { return }
            list.reconfigureRows(at: [IndexPath(row: last - 1, section: 0)])
        }
        showEmpty()
        if following { scrollToNewest(animated: false) }
    }

    private static func paths(_ rows: [Int]) -> [IndexPath] {
        rows.map { IndexPath(row: $0, section: 0) }
    }

    private func showEmpty() {
        empty.isHidden = list.numberOfRows(inSection: 0) > 0
    }

    // MARK: The rows

    /// The log's rows, the note once there is one, and the wait last: the wait is counted only from
    /// when the list was told of it.
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        (session.map { $0.log.rows.count + ($0.log.ended == nil ? 0 : 1) } ?? 0) + (wait == nil ? 0 : 1)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: Self.reuse, for: indexPath)
        let item = item(at: indexPath.row)
        if case .wait = item {
            cell.contentConfiguration = UIHostingConfiguration { ChatRowView(item: item) }
                .margins(.horizontal, 12)
                .margins(.vertical, 6)
        } else {
            cell.contentConfiguration = UIHostingConfiguration { ChatRowView(item: item) }
                .margins(.horizontal, 14)
                .margins(.vertical, 5)
        }
        cell.backgroundColor = .clear
        cell.selectionStyle = .none
        return cell
    }

    private func item(at index: Int) -> ChatItem {
        let log = session?.log
        let rows = log?.rows.count ?? 0
        if index < rows, let log {
            return .row(log.rows[index])
        }
        if index == rows, let ended = log?.ended {
            return .note(ChatLog.words(ended))
        }
        if let wait {
            return .wait(wait.card)
        }
        return .note("")
    }

    /// A tool's row opens the use on its own screen.
    func tableView(_ tableView: UITableView, willSelectRowAt indexPath: IndexPath) -> IndexPath? {
        if case .row(let row) = item(at: indexPath.row), row.tool != nil { return indexPath }
        return nil
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard case .row(let row) = item(at: indexPath.row), let use = row.tool else { return }
        openTool?(use)
    }

    // MARK: Following the newest row

    private func scrollToNewest(animated: Bool) {
        let count = list.numberOfRows(inSection: 0)
        guard count > 0 else { return }
        let last = IndexPath(row: count - 1, section: 0)
        if animated {
            list.scrollToRow(at: last, at: .bottom, animated: true)
            return
        }
        list.scrollToRow(at: last, at: .bottom, animated: false)
        // The rows just come into sight take their own height once laid out; the end is then
        // where it really is.
        list.layoutIfNeeded()
        list.scrollToRow(at: last, at: .bottom, animated: false)
    }

    private func jumpToNewest() {
        following = true
        scrollToNewest(animated: true)
    }

    private var atNewest: Bool {
        list.contentOffset.y + list.bounds.height >= list.contentSize.height + list.adjustedContentInset.bottom - 48
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        following = false
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { following = atNewest }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        following = atNewest
    }

    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        following = false
        return true
    }
}

/// The chat's table, saying when its content's size changed.
private final class ChatList: UITableView {
    var contentSizeChanged: (() -> Void)?

    override var contentSize: CGSize {
        didSet { if contentSize != oldValue { contentSizeChanged?() } }
    }
}

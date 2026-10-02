import SwiftUI
import UIKit

/// The chat, for SwiftUI. It stays mounted while the terminal is shown, hidden, so that switching
/// back finds it as it was.
struct ChatScreen: UIViewRepresentable {
    let session: ChatSession
    let shown: Bool

    func makeUIView(context: Context) -> ChatView {
        let view = ChatView()
        view.session = session
        session.view = view
        return view
    }

    func updateUIView(_ view: ChatView, context: Context) {
        view.isHidden = !shown
    }

    static func dismantleUIView(_ view: ChatView, coordinator: ()) {
        if view.session?.view === view {
            view.session?.view = nil
        }
    }
}

/// What one place in the chat shows: a row, its tool's result unfolded or not, or the note of why
/// the chat is told no more.
enum ChatItem {
    case row(ChatRow, open: Bool)
    case note(String)
}

/// What an agent and the person said to each other (design §5.4, P7): a list that only grows, a row
/// per entry, read from the session's log. A table view keeps its rows' heights one by one, so a
/// telling inserts the rows that are new and draws again the few that changed, measures only the
/// rows in sight, and lays out nothing else again. It follows the newest row until the person
/// scrolls up. SwiftUI draws each row (`ChatRowView`), and markdown's inline styles with it.
final class ChatView: UIView, UITableViewDataSource, UITableViewDelegate {
    /// Where the rows are read from.
    weak var session: ChatSession?

    private static let reuse = "row"
    private let list = UITableView(frame: .zero, style: .plain)
    private let newest: UIButton
    private let empty = UILabel()
    /// The tool rows unfolded, by their entry's id.
    private var open: Set<String> = []
    private var following = true {
        didSet { newest.isHidden = following }
    }

    init() {
        var look = UIButton.Configuration.filled()
        look.image = UIImage(systemName: "arrow.down.to.line")
        look.cornerStyle = .capsule
        newest = UIButton(configuration: look)
        super.init(frame: .zero)

        list.dataSource = self
        list.delegate = self
        list.separatorStyle = .none
        list.rowHeight = UITableView.automaticDimension
        list.estimatedRowHeight = 64
        list.contentInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        list.register(UITableViewCell.self, forCellReuseIdentifier: Self.reuse)
        addSubview(list)

        empty.text = "Nothing said yet"
        empty.textColor = .secondaryLabel
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
        let resized = list.frame.size != bounds.size
        list.frame = bounds
        let size = newest.intrinsicContentSize
        newest.frame = CGRect(
            x: bounds.maxX - size.width - 16, y: bounds.maxY - size.height - 16,
            width: size.width, height: size.height)
        if resized && following { scrollToNewest(animated: false) }
    }

    // MARK: What the session tells

    /// Shows the log afresh: when the chat is attached, and when the conversation is told anew.
    func reload() {
        open.removeAll()
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

    private static func paths(_ rows: [Int]) -> [IndexPath] {
        rows.map { IndexPath(row: $0, section: 0) }
    }

    private func showEmpty() {
        empty.isHidden = list.numberOfRows(inSection: 0) > 0
    }

    // MARK: The rows

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        guard let log = session?.log else { return 0 }
        return log.rows.count + (log.ended == nil ? 0 : 1)
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: Self.reuse, for: indexPath)
        let item = item(at: indexPath.row)
        cell.contentConfiguration = UIHostingConfiguration { ChatRowView(item: item) }
            .margins(.horizontal, 14)
            .margins(.vertical, 5)
        cell.backgroundColor = .clear
        cell.selectionStyle = .none
        return cell
    }

    private func item(at index: Int) -> ChatItem {
        guard let log = session?.log else { return .note("") }
        if index < log.rows.count {
            let row = log.rows[index]
            return .row(row, open: open.contains(row.id))
        }
        return .note(log.ended ?? "")
    }

    /// A tool's use with what it gave back unfolds, and folds again.
    func tableView(_ tableView: UITableView, willSelectRowAt indexPath: IndexPath) -> IndexPath? {
        if case .row(let row, _) = item(at: indexPath.row), row.folds { return indexPath }
        return nil
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        guard case .row(let row, _) = item(at: indexPath.row) else { return }
        if open.remove(row.id) == nil { open.insert(row.id) }
        tableView.reconfigureRows(at: [indexPath])
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

import UIKit

/// The live terminal (design §5.3, §6.4): a scroll view of pooled line views, each line placed at
/// its row × the line height and each run at its column × the cell width, so nothing is measured per
/// frame. An update draws again only the lines it changed; the others move. It keeps the lines it
/// was sent, follows the newest until the person scrolls up, fits the session's columns to its
/// width (the phone never reflows a terminal, §3.6), zooms with a pinch, and types into the session
/// as the person.
final class TerminalView: UIScrollView, UIScrollViewDelegate, UIKeyInput {
    /// Where typing goes.
    weak var session: TerminalSession?
    /// Told when following the newest line stops, or starts again.
    var followingChanged: ((Bool) -> Void)?

    /// The revision last drawn: the next pull asks for what changed since.
    var revision: UInt64 { lines.revision }

    /// How many lines it holds, beyond the core's 2,000, while the person reads further up.
    private static let history: UInt64 = 10_000
    /// The largest font size a pinch reaches.
    private static let largest: CGFloat = 22
    /// Lines placed beyond each edge of the screen, so that a fling meets lines already drawn.
    private static let overscan = 4

    private var lines = TerminalLines()
    private var metrics = TerminalMetrics(size: 12)
    private var palette = TerminalPalette(dark: false)
    /// The font size that fits the session's columns to the width, and the person's zoom over it.
    private var fitted: CGFloat = 12
    private var zoom: CGFloat = 1
    private var fittedWidth: CGFloat = 0
    private var fittedCols = 0
    /// The part of each line its view shows: the whole line, unless it is over twice the width.
    private var slice: (x: CGFloat, width: CGFloat) = (0, 0)
    private var following = true {
        didSet { if following != oldValue { followingChanged?(following) } }
    }
    private var laidOutHeight: CGFloat = 0
    private var pinching = false
    private var pinchAnchor = CGPoint.zero
    private var pinchFinger = CGPoint.zero

    private let content = UIView()
    private let caret = UIView()
    private var shown: [UInt64: TerminalLineView] = [:]
    private var spare: [TerminalLineView] = []
    private lazy var keyRow: KeyRow = KeyRow(
        press: { [weak self] (keys: [String]) in self?.session?.press(keys) },
        hide: { [weak self] in _ = self?.resignFirstResponder() })

    init() {
        super.init(frame: .zero)
        delegate = self
        contentInsetAdjustmentBehavior = .never
        alwaysBounceVertical = true
        // Two fingers pinch; one scrolls.
        panGestureRecognizer.maximumNumberOfTouches = 1
        addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
        addSubview(content)
        caret.isUserInteractionEnabled = false
        content.addSubview(caret)
        isAccessibilityElement = true
        accessibilityLabel = "Terminal"
        accessibilityIdentifier = "agent.terminal"
        restyle()
        _ = registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: TerminalView, _: UITraitCollection) in
            view.restyle()
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    // MARK: What the core sends

    /// One update from the core: the lines it changed are drawn again, the others only move.
    func apply(_ update: ScreenUpdate) {
        let changes = lines.apply(update)
        let gone: UInt64
        if following {
            gone = lines.trim(below: lines.coreFirst)
        } else if lines.count > Int(Self.history) {
            gone = lines.trim(below: lines.end - Self.history)
        } else {
            gone = 0
        }
        if changes.resized || lines.cols != fittedCols {
            fit()
        } else {
            resizeContent()
            for index in changes.lines {
                shown[index]?.show(lines[index], from: slice.x, metrics: metrics, palette: palette)
            }
        }
        if following {
            if !pinching { scrollToNewest() }
        } else if gone > 0 {
            // The lines in sight stay where they are on the screen: what went was above them.
            contentOffset.y = max(0, contentOffset.y - CGFloat(gone) * metrics.lineHeight)
        }
        placeCaret()
        setNeedsLayout()
    }

    /// A new watch numbers its lines from 0 again.
    func reset() {
        lines = TerminalLines()
        following = true
        relayout()
    }

    /// Back to the newest line, and following it again.
    func jumpToNewest() {
        following = true
        setContentOffset(CGPoint(x: contentOffset.x, y: max(0, contentSize.height - bounds.height)), animated: true)
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != fittedWidth { fit() }
        if bounds.height != laidOutHeight {
            laidOutHeight = bounds.height
            if following { scrollToNewest() }
        }
        tile()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { restyle() }
    }

    /// Sizes the font so that the session's columns fill the width, times the person's zoom.
    private func fit() {
        fittedWidth = bounds.width
        fittedCols = lines.cols
        if bounds.width > 0, lines.cols > 0 {
            fitted = bounds.width / (CGFloat(lines.cols) * TerminalMetrics.widthPerPoint)
            zoom = min(max(zoom, 1), max(1, Self.largest / fitted))
            let size = fitted * zoom
            if abs(size - metrics.size) > 0.01 {
                metrics = TerminalMetrics(size: size)
            }
        }
        relayout()
    }

    /// Every line view is let go of, to be placed and drawn again: the cell or the width changed.
    private func relayout() {
        recycle { _ in true }
        slice = (0, 0)
        resizeContent()
        placeCaret()
        setNeedsLayout()
    }

    private func resizeContent() {
        let size = CGSize(
            width: CGFloat(lines.cols) * metrics.cellWidth,
            height: CGFloat(lines.count) * metrics.lineHeight)
        guard contentSize != size else { return }
        contentSize = size
        content.bounds = CGRect(origin: .zero, size: size)
        content.center = CGPoint(x: size.width / 2, y: size.height / 2)
    }

    /// A line view on every line in sight and a few beyond, reusing the ones that left it. A line
    /// view that stays keeps what it drew, and only moves.
    private func tile() {
        let height = metrics.lineHeight
        let count = lines.count
        let first = max(0, Int((contentOffset.y / height).rounded(.down)) - Self.overscan)
        let last = min(count - 1, Int(((contentOffset.y + bounds.height) / height).rounded(.up)) + Self.overscan)
        guard count > 0, first <= last else {
            recycle { _ in true }
            return
        }
        reslice()
        let wanted = (lines.origin + UInt64(first))...(lines.origin + UInt64(last))
        recycle { !wanted.contains($0) }
        for index in wanted {
            let frame = CGRect(
                x: slice.x, y: CGFloat(index - lines.origin) * height, width: slice.width, height: height)
            if let view = shown[index] {
                if view.frame != frame { view.frame = frame }
            } else {
                let view = spare.popLast() ?? makeLineView()
                view.frame = frame
                view.isHidden = false
                view.show(lines[index], from: slice.x, metrics: metrics, palette: palette)
                shown[index] = view
            }
        }
    }

    /// A line view shows the whole line, unless the line is over twice the width (zoomed in on a wide
    /// session): then the part in sight and half a width either side, so that its backing store stays
    /// near the screen's size. Scrolling past that part lays the lines in sight out again.
    private func reslice() {
        let full = contentSize.width
        let width = bounds.width
        let wanted: (x: CGFloat, width: CGFloat)
        if full <= width * 2 {
            wanted = (0, full)
        } else {
            let left = contentOffset.x
            if slice.width > 0, left >= slice.x, left + width <= slice.x + slice.width { return }
            wanted = (min(max(0, left - width / 2), full - width * 2), width * 2)
        }
        guard wanted != slice else { return }
        slice = wanted
        recycle { _ in true }
    }

    private func recycle(where gone: (UInt64) -> Bool) {
        for (index, view) in shown where gone(index) {
            view.isHidden = true
            spare.append(view)
            shown[index] = nil
        }
    }

    private func makeLineView() -> TerminalLineView {
        let view = TerminalLineView(frame: .zero)
        content.insertSubview(view, belowSubview: caret)
        return view
    }

    private func placeCaret() {
        guard let cursor = lines.cursor, cursor.line >= lines.origin, cursor.line < lines.end else {
            caret.isHidden = true
            return
        }
        caret.isHidden = false
        caret.frame = CGRect(
            x: CGFloat(cursor.col) * metrics.cellWidth,
            y: CGFloat(cursor.line - lines.origin) * metrics.lineHeight,
            width: metrics.cellWidth,
            height: metrics.lineHeight)
    }

    private func restyle() {
        palette = TerminalPalette(dark: traitCollection.userInterfaceStyle == .dark)
        backgroundColor = UIColor(cgColor: palette.background)
        caret.backgroundColor = UIColor(cgColor: palette.foreground).withAlphaComponent(0.4)
        for (index, view) in shown {
            view.show(lines[index], from: slice.x, metrics: metrics, palette: palette)
        }
    }

    // MARK: What accessibility reads

    /// The lines in sight, as VoiceOver reads the terminal (and so the UI tests): read when it asks,
    /// from the lines held, never per frame.
    override var accessibilityValue: String? {
        get {
            let height = metrics.lineHeight
            guard lines.count > 0, height > 0, bounds.height > 0 else { return nil }
            let first = max(0, Int((contentOffset.y / height).rounded(.down)))
            let last = min(lines.count - 1, Int(((contentOffset.y + bounds.height) / height).rounded(.up)) - 1)
            guard first <= last else { return nil }
            var shown = (first...last).map { lines[lines.origin + UInt64($0)]?.text ?? "" }
            while shown.last?.isEmpty == true { shown.removeLast() }
            return shown.isEmpty ? nil : shown.joined(separator: "\n")
        }
        set { super.accessibilityValue = newValue }
    }

    // MARK: Following the newest line

    private func scrollToNewest() {
        let bottom = max(0, contentSize.height - bounds.height)
        if contentOffset.y != bottom {
            contentOffset = CGPoint(x: contentOffset.x, y: bottom)
        }
    }

    private var atNewest: Bool {
        contentOffset.y >= contentSize.height - bounds.height - metrics.lineHeight
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

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        following = atNewest
    }

    // MARK: Pinch to zoom

    /// While the fingers move, the drawn lines are scaled about the point under them; when they
    /// lift, the font takes the new size and the lines are laid out again, crisp, with that point
    /// still under the fingers.
    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        switch pinch.state {
        case .began:
            pinching = true
            pinchAnchor = pinch.location(in: content)
            pinchFinger = pinch.location(in: self)
        case .changed:
            pinchFinger = pinch.location(in: self)
            let scale = pinchScale(pinch.scale)
            let center = content.center
            content.transform = CGAffineTransform(
                a: scale, b: 0, c: 0, d: scale,
                tx: pinchFinger.x - center.x - scale * (pinchAnchor.x - center.x),
                ty: pinchFinger.y - center.y - scale * (pinchAnchor.y - center.y))
        case .ended, .cancelled, .failed:
            pinching = false
            commitZoom(pinchScale(pinch.scale))
        default:
            break
        }
    }

    /// The pinch's scale, kept to font sizes between the fitted one and the largest.
    private func pinchScale(_ scale: CGFloat) -> CGFloat {
        let size = min(max(metrics.size * scale, fitted), max(fitted, Self.largest))
        return size / metrics.size
    }

    private func commitZoom(_ scale: CGFloat) {
        content.transform = .identity
        guard abs(scale - 1) > 0.001 else { return }
        let before = metrics
        let onScreen = CGPoint(x: pinchFinger.x - contentOffset.x, y: pinchFinger.y - contentOffset.y)
        zoom = metrics.size * scale / fitted
        fit()
        let anchor = CGPoint(
            x: pinchAnchor.x * metrics.cellWidth / before.cellWidth,
            y: pinchAnchor.y * metrics.lineHeight / before.lineHeight)
        let maxX = max(0, contentSize.width - bounds.width)
        let maxY = max(0, contentSize.height - bounds.height)
        contentOffset = CGPoint(
            x: min(max(0, anchor.x - onScreen.x), maxX),
            y: following ? maxY : min(max(0, anchor.y - onScreen.y), maxY))
    }

    // MARK: Typing, as the person

    override var canBecomeFirstResponder: Bool { true }

    override var inputAccessoryView: UIView? { keyRow }

    var hasText: Bool { true }

    func insertText(_ text: String) {
        if text == "\n" {
            session?.press(["enter"])
        } else {
            session?.type(text)
        }
    }

    func deleteBackward() {
        session?.press(["backspace"])
    }

    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
}

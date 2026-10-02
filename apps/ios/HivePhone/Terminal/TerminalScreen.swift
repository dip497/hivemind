import SwiftUI
import UIKit

/// The terminal, for SwiftUI.
struct TerminalScreen: UIViewRepresentable {
    let session: TerminalSession

    func makeUIView(context: Context) -> TerminalContainer {
        let container = TerminalContainer()
        container.terminal.session = session
        session.view = container.terminal
        return container
    }

    func updateUIView(_ container: TerminalContainer, context: Context) {}

    static func dismantleUIView(_ container: TerminalContainer, coordinator: ()) {
        if container.terminal.session?.view === container.terminal {
            container.terminal.session?.view = nil
        }
    }
}

/// The terminal, and a button back to its newest line while the person reads further up.
final class TerminalContainer: UIView {
    let terminal = TerminalView()
    private let newest: UIButton

    init() {
        var look = UIButton.Configuration.filled()
        look.image = UIImage(systemName: "arrow.down.to.line")
        look.cornerStyle = .capsule
        newest = UIButton(configuration: look)
        super.init(frame: .zero)
        addSubview(terminal)
        newest.accessibilityLabel = "Back to the newest line"
        newest.isHidden = true
        newest.addAction(UIAction { [weak self] _ in self?.terminal.jumpToNewest() }, for: .primaryActionTriggered)
        addSubview(newest)
        terminal.followingChanged = { [weak self] following in
            self?.newest.isHidden = following
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        terminal.frame = bounds
        let size = newest.intrinsicContentSize
        newest.frame = CGRect(
            x: bounds.maxX - size.width - 16, y: bounds.maxY - size.height - 16,
            width: size.width, height: size.height)
    }
}

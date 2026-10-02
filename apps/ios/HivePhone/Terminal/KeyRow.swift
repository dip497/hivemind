import UIKit

/// The keys a phone's keyboard lacks, above it while typing into a terminal (design §6.4): Esc, Tab,
/// the arrows, Enter and Ctrl-C, sent as the tokens `hive ctl keys` takes.
final class KeyRow: UIInputView {
    private static let keys: [(title: String, token: String)] = [
        ("esc", "escape"), ("tab", "tab"), ("←", "left"), ("↑", "up"), ("↓", "down"), ("→", "right"),
        ("⏎", "enter"), ("^C", "ctrl-c"),
    ]

    init(press: @escaping ([String]) -> Void, hide: @escaping () -> Void) {
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 48), inputViewStyle: .keyboard)
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.spacing = 6
        for key in Self.keys {
            var look = UIButton.Configuration.gray()
            look.title = key.title
            look.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 2, bottom: 4, trailing: 2)
            let token = key.token
            let button = UIButton(configuration: look, primaryAction: UIAction { _ in press([token]) })
            button.accessibilityLabel = token
            row.addArrangedSubview(button)
        }
        var hideLook = UIButton.Configuration.plain()
        hideLook.image = UIImage(systemName: "keyboard.chevron.compact.down")
        let hideButton = UIButton(configuration: hideLook, primaryAction: UIAction { _ in hide() })
        hideButton.accessibilityLabel = "Hide the keyboard"
        row.addArrangedSubview(hideButton)

        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }
}

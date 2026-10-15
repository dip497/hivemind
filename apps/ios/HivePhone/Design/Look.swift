import SwiftUI
import UIKit

/// The phone's colours as UIKit draws them, light and dark: neutral greyscale, with colour kept for
/// what waits on the person, what failed, what is done and a diff's lines.
enum Tones {
    static var background: UIColor { tone(0xffffff, 0x191919) }
    /// Cards, sheets and the composer.
    static var raised: UIColor { tone(0xf7f7f7, 0x212121) }
    /// A chosen chip, a pressed control.
    static var selected: UIColor { tone(0xededed, 0x2b2b2b) }
    static var text: UIColor { tone(0x171717, 0xf4f4f4) }
    static var secondary: UIColor { tone(0x5d5d5d, 0xa3a3a3) }
    /// The faintest text; as the secondary when the person asks for more contrast.
    static var tertiary: UIColor {
        UIColor { traits in
            let dark = traits.userInterfaceStyle == .dark
            if traits.accessibilityContrast == .high { return Tones.rgb(dark ? 0xa3a3a3 : 0x5d5d5d) }
            return Tones.rgb(dark ? 0x6e6e6e : 0x8f8f8f)
        }
    }
    static var hairline: UIColor { tone(0xe5e5e5, 0x2e2e2e) }
    /// An outlined button's edge.
    static var outline: UIColor { tone(0xd4d4d4, 0x3d3d3d) }
    /// The text on a filled button.
    static var onPrimary: UIColor { tone(0xffffff, 0x171717) }
    static var waiting: UIColor { tone(0xb26a00, 0xe8a64a) }
    static var failed: UIColor { tone(0xd73a49, 0xf0707b) }
    static var done: UIColor { tone(0x258b20, 0x5fbf57) }

    static func tone(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { traits in Tones.rgb(traits.userInterfaceStyle == .dark ? dark : light) }
    }

    private static func rgb(_ value: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1)
    }

    /// The bars drawn quiet: the page's own ground, the screen's name in the text colour, the tabs'
    /// chosen one in the text colour and the rest faint, what waits on the person counted in amber.
    @MainActor
    static func styleBars() {
        let nav = UINavigationBarAppearance()
        nav.configureWithOpaqueBackground()
        nav.backgroundColor = background
        nav.shadowColor = .clear
        nav.titleTextAttributes = [
            .foregroundColor: text,
            .font: UIFont.systemFont(ofSize: 17, weight: .semibold),
            .kern: -0.34,
        ]
        nav.largeTitleTextAttributes = [
            .foregroundColor: text,
            .font: UIFont.systemFont(ofSize: 32, weight: .semibold),
            .kern: -0.64,
        ]
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = nav
        bar.compactAppearance = nav
        bar.scrollEdgeAppearance = nav

        let tabs = UITabBarAppearance()
        tabs.configureWithOpaqueBackground()
        tabs.backgroundColor = background
        tabs.shadowColor = hairline
        for item in [tabs.stackedLayoutAppearance, tabs.inlineLayoutAppearance, tabs.compactInlineLayoutAppearance] {
            item.normal.iconColor = tertiary
            item.normal.titleTextAttributes = [.foregroundColor: tertiary]
            item.normal.badgeBackgroundColor = waiting
            item.selected.iconColor = text
            item.selected.titleTextAttributes = [.foregroundColor: text]
        }
        let tabBar = UITabBar.appearance()
        tabBar.standardAppearance = tabs
        tabBar.scrollEdgeAppearance = tabs
    }
}

/// The phone's colours and shapes as SwiftUI draws them (`Tones`).
enum Look {
    static var background: Color { Color(uiColor: Tones.background) }
    static var raised: Color { Color(uiColor: Tones.raised) }
    static var selected: Color { Color(uiColor: Tones.selected) }
    static var text: Color { Color(uiColor: Tones.text) }
    static var secondary: Color { Color(uiColor: Tones.secondary) }
    static var tertiary: Color { Color(uiColor: Tones.tertiary) }
    static var hairline: Color { Color(uiColor: Tones.hairline) }
    static var outline: Color { Color(uiColor: Tones.outline) }
    static var onPrimary: Color { Color(uiColor: Tones.onPrimary) }
    static var waiting: Color { Color(uiColor: Tones.waiting) }
    static var failed: Color { Color(uiColor: Tones.failed) }
    static var done: Color { Color(uiColor: Tones.done) }

    /// Cards and the composer.
    static let cardRadius: CGFloat = 18
}

extension View {
    /// Raised off the page: a card, the composer, a prompt. `floating` adds a soft shadow.
    func raisedCard(floating: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: Look.cardRadius, style: .continuous)
        return background(Look.raised, in: shape)
            .overlay { shape.strokeBorder(Look.hairline, lineWidth: 1) }
            .shadow(color: .black.opacity(floating ? 0.06 : 0), radius: 8, x: 0, y: 2)
    }

    /// A row of a plain list on the page's own ground, its separator a hairline.
    func pageRow() -> some View {
        listRowBackground(Look.background)
            .listRowSeparatorTint(Look.hairline)
    }

    /// A screen on the page's own ground.
    func pageGround() -> some View {
        scrollContentBackground(.hidden)
            .background(Look.background)
    }
}

/// A full-width pill: filled for the first answer, outlined for the others.
struct PillButtonStyle: ButtonStyle {
    let filled: Bool

    func makeBody(configuration: Configuration) -> some View {
        Pill(configuration: configuration, filled: filled)
    }

    private struct Pill: View {
        let configuration: ButtonStyleConfiguration
        let filled: Bool
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .foregroundStyle(filled ? Look.onPrimary : Look.text)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity)
                .background(filled ? Look.text : Look.background, in: Capsule())
                .overlay {
                    if !filled {
                        Capsule().strokeBorder(Look.outline, lineWidth: 1)
                    }
                }
                .contentShape(Capsule())
                .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
        }
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var filledPill: PillButtonStyle { PillButtonStyle(filled: true) }
    static var outlinedPill: PillButtonStyle { PillButtonStyle(filled: false) }
}

/// An option of a question as a compact pill: its label, and what it means under it; outlined, and
/// filled once chosen.
struct ChoiceButtonStyle: ButtonStyle {
    let chosen: Bool

    func makeBody(configuration: Configuration) -> some View {
        Pill(configuration: configuration, chosen: chosen)
    }

    private struct Pill: View {
        let configuration: ButtonStyleConfiguration
        let chosen: Bool
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .foregroundStyle(chosen ? Look.onPrimary : Look.text)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(chosen ? Look.text : Look.background, in: Capsule())
                .overlay {
                    if !chosen {
                        Capsule().strokeBorder(Look.outline, lineWidth: 1)
                    }
                }
                .contentShape(Capsule())
                .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
        }
    }
}

extension ButtonStyle where Self == ChoiceButtonStyle {
    static func choicePill(chosen: Bool) -> ChoiceButtonStyle { ChoiceButtonStyle(chosen: chosen) }
}

/// A round dot: filled, or a ring when not.
struct Dot: View {
    let color: Color
    var filled = true

    var body: some View {
        Group {
            if filled {
                Circle().fill(color)
            } else {
                Circle().strokeBorder(color, lineWidth: 1.5)
            }
        }
        .frame(width: 8, height: 8)
    }
}

/// A pill to choose by: the chosen one filled, the rest outlined by a hairline; a device's with a
/// dot, filled when the phone reaches it.
struct Chip: View {
    let label: String
    let selected: Bool
    var reached: Bool? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let reached {
                    Dot(color: reached ? Look.done : Look.tertiary, filled: reached)
                }
                Text(label)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
            }
            .foregroundStyle(selected ? Look.text : Look.secondary)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(selected ? Look.selected : Look.background, in: Capsule())
            .overlay { Capsule().strokeBorder(selected ? Look.selected : Look.hairline, lineWidth: 1) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A small grey label over a group: a device and workspace, Device, Agent.
struct GroupLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(Look.tertiary)
    }
}

/// An agent's state as a row's trailing mark: a spinner while it works, an amber dot while it waits
/// on the person, a red one once it failed or hit its limit; nothing otherwise.
struct StateMark: View {
    let state: AgentState

    var body: some View {
        Group {
            switch state {
            case .working:
                ProgressView()
                    .controlSize(.mini)
                    .tint(Look.secondary)
            case .waiting:
                Dot(color: Look.waiting)
            case .failed, .limited:
                Dot(color: Look.failed)
            case .idle, .done, .interrupted, .exited:
                EmptyView()
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
    }
}

/// Views side by side, wrapping onto the next row where the width runs out.
struct WrappingRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = lines(of: subviews, width: proposal.width)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in lines(of: subviews, width: bounds.width) {
            var x = bounds.minX
            for (index, size) in zip(row.indices, row.sizes) {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Line {
        var indices: [Int] = []
        var sizes: [CGSize] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func lines(of subviews: Subviews, width: CGFloat?) -> [Line] {
        let room = width ?? .infinity
        var rows: [Line] = []
        var line = Line()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            if !line.indices.isEmpty && line.width + spacing + size.width > room {
                rows.append(line)
                line = Line()
            }
            line.width += (line.indices.isEmpty ? 0 : spacing) + size.width
            line.height = max(line.height, size.height)
            line.indices.append(index)
            line.sizes.append(size)
        }
        if !line.indices.isEmpty { rows.append(line) }
        return rows
    }
}

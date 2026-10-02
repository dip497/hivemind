import UIKit

/// The screen and the look the app gives a community view (design §5.5, §6.1; the view protocol's
/// `viewport` and `theme`). The look is the app's own: the system's colours its screens are drawn
/// in, for dark or light and the person's contrast setting; the person's colour as its accent, as
/// the app is tinted with it (`RootView`); an agent's state as `AgentLook.color` paints it; and the
/// terminal's background (`TerminalPalette`). Each by the tokens the desktop gives views, as
/// `#rrggbb`: the computer refuses any other colour.
enum ViewLook {
    /// The look for dark or light, with the contrast increased or not, and the person's colour.
    static func theme(dark: Bool, increasedContrast: Bool, accent: String?) -> ViewTheme {
        let traits = UITraitCollection { traits in
            traits.userInterfaceStyle = dark ? .dark : .light
            traits.accessibilityContrast = increasedContrast ? .high : .normal
        }
        let ground = UIColor.systemBackground.resolvedColor(with: traits)
        func token(_ color: UIColor) -> String {
            hex(color.resolvedColor(with: traits), over: ground)
        }
        let tint = colour(accent) ?? token(UIColor.systemBlue)
        let colors = [
            "bg": token(UIColor.systemBackground),
            "bg2": token(UIColor.secondarySystemBackground),
            "bg3": token(UIColor.tertiarySystemBackground),
            "bg4": token(dark ? UIColor.systemGray4 : UIColor.systemGray5),
            "fg": token(UIColor.label),
            "fg2": token(UIColor.secondaryLabel),
            "fg3": token(UIColor.tertiaryLabel),
            "line": token(UIColor.opaqueSeparator),
            "line2": token(UIColor.systemGray2),
            "brand": tint,
            "accent": tint,
            "ok": token(UIColor.systemGreen),
            "warn": token(UIColor.systemOrange),
            "err": token(UIColor.systemRed),
            "info": token(UIColor.systemBlue),
        ]
        let status = [
            "working": token(UIColor.systemGreen),
            "attention": token(UIColor.systemOrange),
            "done": token(UIColor.systemBlue),
            "idle": token(UIColor.systemGray),
            "exited": token(UIColor.systemGray),
            "failed": token(UIColor.systemRed),
        ]
        return ViewTheme(
            mode: dark ? .dark : .light,
            colors: colors,
            accent: tint,
            radius: 12,
            fonts: ViewFonts(ui: "-apple-system, system-ui, sans-serif", mono: "ui-monospace, Menlo, monospace"),
            surface: colors["bg2"],
            terminalBackground: token(UIColor(cgColor: TerminalPalette(dark: dark).background)),
            glass: false,
            status: status)
    }

    /// The web view's size as the view is told it: whole CSS pixels, which are points, at most what
    /// the computer takes.
    static func size(_ size: CGSize) -> (width: UInt32, height: UInt32) {
        func whole(_ length: CGFloat) -> UInt32 {
            guard length.isFinite else { return 0 }
            return UInt32(min(max(length.rounded(), 0), 100_000))
        }
        return (whole(size.width), whole(size.height))
    }

    /// The person's colour as the computer takes it, `#rrggbb`; none when it is not one.
    private static func colour(_ hex: String?) -> String? {
        let digits = "0123456789abcdefABCDEF"
        guard let hex, hex.count == 7, hex.hasPrefix("#"), hex.dropFirst().allSatisfy({ digits.contains($0) }) else {
            return nil
        }
        return hex.lowercased()
    }

    /// `color` as `#rrggbb`, laid over `ground` where it lets some of it through (the secondary and
    /// tertiary labels do).
    private static func hex(_ color: UIColor, over ground: UIColor) -> String {
        var (red, green, blue, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 1)
        var (groundRed, groundGreen, groundBlue): (CGFloat, CGFloat, CGFloat) = (0, 0, 0)
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        ground.getRed(&groundRed, green: &groundGreen, blue: &groundBlue, alpha: nil)
        let opacity = min(max(alpha, 0), 1)
        func channel(_ top: CGFloat, _ under: CGFloat) -> String {
            let mixed = top * opacity + under * (1 - opacity)
            let byte = Int((min(max(mixed, 0), 1) * 255).rounded())
            let digits = String(byte, radix: 16)
            return digits.count < 2 ? "0" + digits : digits
        }
        return "#" + channel(red, groundRed) + channel(green, groundGreen) + channel(blue, groundBlue)
    }
}

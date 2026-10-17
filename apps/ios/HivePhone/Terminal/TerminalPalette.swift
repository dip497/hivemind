import CoreGraphics

/// A run's colours on this screen's theme (design §5.3): the default foreground and background, 16
/// standard colours chosen for light and for dark, then xterm's 6×6×6 cube and its 24 greys.
struct TerminalPalette {
    let foreground: CGColor
    let background: CGColor
    private let standard: [CGColor]

    init(dark: Bool) {
        let ansi: [UInt32]
        if dark {
            foreground = Self.rgb(0xe6e6eb)
            background = Self.rgb(0x0f0f12)
            ansi = [
                0x2e2e33, 0xff6b6b, 0x5fd38d, 0xf5c451, 0x5c9dff, 0xd987ff, 0x4fd1d9, 0xd0d0d6,
                0x6e6e78, 0xff8f8f, 0x86e5a8, 0xffd97a, 0x85b6ff, 0xe6a8ff, 0x7ee3ea, 0xf5f5f7,
            ]
        } else {
            foreground = Self.rgb(0x1d1d1f)
            background = Self.rgb(0xffffff)
            ansi = [
                0x1d1d1f, 0xc4262e, 0x1f8a3b, 0x9a6a00, 0x1f5fd1, 0x9a3cc4, 0x0f7f8a, 0xb8b8c0,
                0x6e6e78, 0xe0464d, 0x2fa952, 0xb88600, 0x3d7cf0, 0xb85ee0, 0x1a9aa6, 0x8e8e96,
            ]
        }
        standard = ansi.map { Self.rgb($0) }
    }

    /// A run's ink and the paint under it (nil: the line's own background), inverse and dim applied.
    func colors(of run: TerminalRun) -> (ink: CGColor, paint: CGColor?) {
        var ink = color(TerminalColor(run.fg)) ?? foreground
        var paint = color(TerminalColor(run.bg))
        if run.inverse {
            let under = ink
            ink = paint ?? background
            paint = under
        }
        if run.dim {
            ink = ink.copy(alpha: 0.55) ?? ink
        }
        return (ink, paint)
    }

    /// nil for the theme's own colour.
    private func color(_ color: TerminalColor) -> CGColor? {
        switch color {
        case .standard:
            return nil
        case .palette(let index):
            return indexed(Int(index))
        case .rgb(let red, let green, let blue):
            return Self.rgb(UInt32(red) << 16 | UInt32(green) << 8 | UInt32(blue))
        }
    }

    private func indexed(_ index: Int) -> CGColor {
        if index < 16 { return standard[index] }
        if index < 232 {
            let levels: [UInt32] = [0, 95, 135, 175, 215, 255]
            let cube = index - 16
            return Self.rgb(levels[cube / 36] << 16 | levels[(cube / 6) % 6] << 8 | levels[cube % 6])
        }
        let grey = UInt32(8 + (index - 232) * 10)
        return Self.rgb(grey << 16 | grey << 8 | grey)
    }

    private static func rgb(_ hex: UInt32) -> CGColor {
        CGColor(
            srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1)
    }
}

import CoreText
import UIKit

/// The terminal's cell at one font size, from the monospace font's own advance and line height,
/// taken once per size: every run is placed at `col × cellWidth` and every line at
/// `row × lineHeight`, and no text is measured per frame (design §5.3).
struct TerminalMetrics {
    let size: CGFloat
    let cellWidth: CGFloat
    let lineHeight: CGFloat
    /// From a line's top to its baseline.
    let baseline: CGFloat
    /// The thickness of an underline or a strikethrough, and where each sits from the line's top.
    let rule: CGFloat
    let underline: CGFloat
    let strikethrough: CGFloat
    private let regular: UIFont
    private let bold: UIFont
    private let italic: UIFont
    private let boldItalic: UIFont

    init(size: CGFloat) {
        self.size = size
        regular = .monospacedSystemFont(ofSize: size, weight: .regular)
        bold = .monospacedSystemFont(ofSize: size, weight: .bold)
        italic = Self.slanted(regular)
        boldItalic = Self.slanted(bold)
        cellWidth = Self.advance(of: regular)
        lineHeight = ceil(regular.lineHeight)
        baseline = (lineHeight - regular.lineHeight) / 2 + regular.ascender
        rule = max(0.5, size / 14)
        underline = baseline + max(1, size / 10)
        strikethrough = baseline - regular.xHeight / 2
    }

    func font(bold isBold: Bool, italic isItalic: Bool) -> UIFont {
        switch (isBold, isItalic) {
        case (false, false): return regular
        case (true, false): return bold
        case (false, true): return italic
        case (true, true): return boldItalic
        }
    }

    /// A cell's width for each point of font size, to fit a session's columns to a width.
    static let widthPerPoint: CGFloat = advance(of: .monospacedSystemFont(ofSize: 100, weight: .regular)) / 100

    /// The font size a terminal fitted to the phone reads at.
    static let readable: CGFloat = 12

    /// The columns and rows a view `width` × `height` points shows at the readable size: as many
    /// columns as fit at it, at least 20; then as many rows, at least 5, each as tall as the view
    /// draws a line once those columns fill its width.
    static func readableSize(width: CGFloat, height: CGFloat) -> TerminalSize? {
        guard width > 0, height > 0 else { return nil }
        let cols = max(20, Int((width / (readable * widthPerPoint)).rounded(.down)))
        let line = TerminalMetrics(size: width / (CGFloat(cols) * widthPerPoint)).lineHeight
        let rows = max(5, Int((height / max(1, line)).rounded(.down)))
        return TerminalSize(cols: cols, rows: rows)
    }

    /// The font's advance, measured once per size on one character: every character of a monospace
    /// font has it.
    private static func advance(of font: UIFont) -> CGFloat {
        let probe = NSAttributedString(string: "M", attributes: [.font: font])
        return CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(probe as CFAttributedString), nil, nil, nil))
    }

    private static func slanted(_ font: UIFont) -> UIFont {
        let traits = font.fontDescriptor.symbolicTraits.union(.traitItalic)
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(traits) else { return font }
        return UIFont(descriptor: descriptor, size: font.pointSize)
    }
}

/// A terminal's size in cells.
struct TerminalSize: Equatable {
    let cols: Int
    let rows: Int
}

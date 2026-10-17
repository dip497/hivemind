import CoreText
import UIKit

/// One line laid out for drawing, once, when the line or the cell changes (design §5.3): the paint
/// under its runs, its glyphs, and its rules. Each character is placed in its run's cells, at
/// `col × cellWidth`, whichever font CoreText found it in, so that a fallback glyph's own width never
/// pushes the rest of the line off the grid.
struct LineLayout {
    private struct Fill {
        let rect: CGRect
        let color: CGColor
    }

    private struct Glyphs {
        let font: CTFont
        let color: CGColor
        var glyphs: [CGGlyph]
        var positions: [CGPoint]
    }

    private let baseline: CGFloat
    private var fills: [Fill] = []
    private var batches: [Glyphs] = []
    private var rules: [Fill] = []

    init(line: TerminalLine, metrics: TerminalMetrics, palette: TerminalPalette) {
        baseline = metrics.baseline
        let text = NSString(string: line.text)
        let length = text.length
        guard length > 0, !line.runs.isEmpty else { return }
        let width = metrics.cellWidth
        let attributed = NSMutableAttributedString(string: line.text)
        // For each UTF-16 unit: the cell its character starts at (-1: in no run, not drawn), the unit
        // its character starts at, and its run.
        var cellOf = [Int](repeating: -1, count: length)
        var headOf = [Int](repeating: 0, count: length)
        var runOf = [Int](repeating: 0, count: length)
        var inks: [CGColor] = []
        inks.reserveCapacity(line.runs.count)

        for (index, run) in line.runs.enumerated() {
            let colors = palette.colors(of: run)
            inks.append(colors.ink)
            let end = run.start + run.length
            guard run.start >= 0, run.length > 0, end <= length else { continue }
            attributed.addAttribute(
                .font, value: metrics.font(bold: run.bold, italic: run.italic),
                range: NSRange(location: run.start, length: run.length))
            var unit = run.start
            var cell = run.col
            while unit < end {
                let character = text.rangeOfComposedCharacterSequence(at: unit)
                let next = max(unit + 1, min(character.location + character.length, end))
                for part in unit..<next {
                    cellOf[part] = cell
                    headOf[part] = unit
                    runOf[part] = index
                }
                cell += run.wide ? 2 : 1
                unit = next
            }
            let span = CGRect(
                x: CGFloat(run.col) * width, y: 0, width: CGFloat(cell - run.col) * width, height: metrics.lineHeight)
            if let paint = colors.paint {
                fills.append(Fill(rect: span, color: paint))
            }
            if run.underline {
                rules.append(Fill(
                    rect: CGRect(x: span.minX, y: metrics.underline, width: span.width, height: metrics.rule),
                    color: colors.ink))
            }
            if run.strikethrough {
                rules.append(Fill(
                    rect: CGRect(x: span.minX, y: metrics.strikethrough, width: span.width, height: metrics.rule),
                    color: colors.ink))
            }
        }

        let typeset = CTLineCreateWithAttributedString(attributed as CFAttributedString)
        let glyphRuns = CTLineGetGlyphRuns(typeset) as! [CTRun]
        // Where CoreText put each character's first glyph, by the unit the character starts at: a
        // character moves to its cell whole, its marks with it.
        var natural: [Int: CGFloat] = [:]
        for glyphRun in glyphRuns {
            let count = CTRunGetGlyphCount(glyphRun)
            guard count > 0 else { continue }
            let attributes = CTRunGetAttributes(glyphRun) as NSDictionary
            guard let value = attributes[kCTFontAttributeName as String] else { continue }
            let font = value as! CTFont
            var glyphs = [CGGlyph](repeating: 0, count: count)
            var points = [CGPoint](repeating: .zero, count: count)
            var units = [CFIndex](repeating: 0, count: count)
            let all = CFRange(location: 0, length: 0)
            CTRunGetGlyphs(glyphRun, all, &glyphs)
            CTRunGetPositions(glyphRun, all, &points)
            CTRunGetStringIndices(glyphRun, all, &units)
            for glyph in 0..<count {
                let unit = units[glyph]
                guard unit >= 0, unit < length, cellOf[unit] >= 0, !line.runs[runOf[unit]].hidden else { continue }
                let head = headOf[unit]
                let start = natural[head] ?? points[glyph].x
                natural[head] = start
                let x = CGFloat(cellOf[unit]) * width + (points[glyph].x - start)
                add(glyphs[glyph], at: CGPoint(x: x, y: points[glyph].y), font: font, color: inks[runOf[unit]])
            }
        }
    }

    private mutating func add(_ glyph: CGGlyph, at point: CGPoint, font: CTFont, color: CGColor) {
        if let last = batches.indices.last, batches[last].font === font, batches[last].color === color {
            batches[last].glyphs.append(glyph)
            batches[last].positions.append(point)
        } else {
            batches.append(Glyphs(font: font, color: color, glyphs: [glyph], positions: [point]))
        }
    }

    /// Paints the line into a line view whose left edge is `offset` into the line.
    func draw(in context: CGContext, offset: CGFloat) {
        context.translateBy(x: -offset, y: 0)
        for fill in fills {
            context.setFillColor(fill.color)
            context.fill(fill.rect)
        }
        if !batches.isEmpty {
            // CoreText draws with y up from the baseline.
            context.saveGState()
            context.textMatrix = .identity
            context.translateBy(x: 0, y: baseline)
            context.scaleBy(x: 1, y: -1)
            for batch in batches {
                context.setFillColor(batch.color)
                CTFontDrawGlyphs(batch.font, batch.glyphs, batch.positions, batch.glyphs.count, context)
            }
            context.restoreGState()
        }
        for rule in rules {
            context.setFillColor(rule.color)
            context.fill(rule.rect)
        }
    }
}

/// One pooled line of the terminal. It draws its layout, and draws again only when its line, the
/// cell or the part of the line it shows changes, never because it moved.
final class TerminalLineView: UIView {
    private var layout: LineLayout?
    private var offset: CGFloat = 0
    private var paper: CGColor = UIColor.black.cgColor

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        isUserInteractionEnabled = false
        contentMode = .topLeft
        clearsContextBeforeDrawing = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func show(_ line: TerminalLine?, from offset: CGFloat, metrics: TerminalMetrics, palette: TerminalPalette) {
        layout = line.map { LineLayout(line: $0, metrics: metrics, palette: palette) }
        self.offset = offset
        paper = palette.background
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.setFillColor(paper)
        context.fill(bounds)
        layout?.draw(in: context, offset: offset)
    }
}

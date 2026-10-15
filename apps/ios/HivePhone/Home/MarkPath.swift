import SwiftUI

/// A mark's path as the core writes it (`MarkShape.d`): absolute moves, lines, cubic and quadratic
/// curves and closes (`M L C Q Z`), the only commands it sends.
enum MarkPath {
    /// The path `d` draws; none when it holds anything else, so a mark is never drawn half-read.
    static func read(_ d: String) -> Path? {
        guard let tokens = tokens(of: d) else { return nil }
        var path = Path()
        var command: Character? = nil
        var moved = false
        var index = 0
        while index < tokens.count {
            if case .command(let letter) = tokens[index] {
                index += 1
                guard "MLCQZ".contains(letter) else { return nil }
                if letter == "Z" {
                    guard moved else { return nil }
                    path.closeSubpath()
                    command = nil
                } else {
                    command = letter
                }
                continue
            }
            guard let letter = command else { return nil }
            let count = letter == "C" ? 6 : letter == "Q" ? 4 : 2
            guard index + count <= tokens.count else { return nil }
            var n: [CGFloat] = []
            for token in tokens[index..<index + count] {
                guard case .number(let value) = token else { return nil }
                n.append(CGFloat(value))
            }
            index += count
            switch letter {
            case "M":
                path.move(to: CGPoint(x: n[0], y: n[1]))
                moved = true
                // Pairs after a move's first are lines.
                command = "L"
            case "L":
                guard moved else { return nil }
                path.addLine(to: CGPoint(x: n[0], y: n[1]))
            case "Q":
                guard moved else { return nil }
                path.addQuadCurve(to: CGPoint(x: n[2], y: n[3]), control: CGPoint(x: n[0], y: n[1]))
            default:
                guard moved else { return nil }
                path.addCurve(
                    to: CGPoint(x: n[4], y: n[5]),
                    control1: CGPoint(x: n[0], y: n[1]),
                    control2: CGPoint(x: n[2], y: n[3]))
            }
        }
        return moved ? path : nil
    }

    private enum Token {
        case command(Character)
        case number(Double)
    }

    /// Letters and numbers, numbers written as SVG allows: signed, with a fraction and an exponent,
    /// the next one starting where a sign or a second point does.
    private static func tokens(of d: String) -> [Token]? {
        let bytes = Array(d.utf8)
        var out: [Token] = []
        var i = 0
        func digit(_ at: Int) -> Bool { at < bytes.count && bytes[at] >= 48 && bytes[at] <= 57 }
        while i < bytes.count {
            let b = bytes[i]
            if b == 32 || b == 44 || b == 9 || b == 10 || b == 13 {
                i += 1
                continue
            }
            if (b >= 65 && b <= 90) || (b >= 97 && b <= 122) {
                out.append(.command(Character(UnicodeScalar(b))))
                i += 1
                continue
            }
            let start = i
            if b == 43 || b == 45 { i += 1 }
            var digits = false
            while digit(i) {
                i += 1
                digits = true
            }
            if i < bytes.count && bytes[i] == 46 {
                i += 1
                while digit(i) {
                    i += 1
                    digits = true
                }
            }
            guard digits else { return nil }
            if i < bytes.count && (bytes[i] == 101 || bytes[i] == 69) {
                var j = i + 1
                if j < bytes.count && (bytes[j] == 43 || bytes[j] == 45) { j += 1 }
                if digit(j) {
                    while digit(j) { j += 1 }
                    i = j
                }
            }
            guard let text = String(bytes: bytes[start..<i], encoding: .utf8), let value = Double(text) else {
                return nil
            }
            out.append(.number(value))
        }
        return out
    }
}

/// A mark drawn in the foreground colour, its box fitted into the frame it is given and centred.
struct MarkView: View {
    let mark: AgentMark

    var body: some View {
        Canvas { context, size in
            let width = CGFloat(mark.width)
            let height = CGFloat(mark.height)
            guard width > 0, height > 0 else { return }
            let scale = min(size.width / width, size.height / height)
            let dx = (size.width - width * scale) / 2 - CGFloat(mark.x) * scale
            let dy = (size.height - height * scale) / 2 - CGFloat(mark.y) * scale
            context.concatenate(CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: dx, ty: dy))
            for shape in mark.shapes {
                guard let path = MarkPath.read(shape.d) else { continue }
                var layer = context
                layer.opacity = shape.opacity
                if shape.fill {
                    layer.fill(path, with: .foreground, style: FillStyle(eoFill: shape.evenOdd))
                }
                if shape.stroke > 0 {
                    layer.stroke(
                        path, with: .foreground,
                        style: StrokeStyle(
                            lineWidth: CGFloat(shape.stroke),
                            lineCap: shape.round ? .round : .butt,
                            lineJoin: shape.round ? .round : .miter))
                }
            }
        }
        .accessibilityHidden(true)
    }
}

/// The desktop's own marks for a frame, drawn as agent marks are: a folder, open or shut, and a
/// branch for a worktree, on a 24-point box, outlined 2 wide with round ends.
enum FrameGlyph {
    static func folder(open: Bool, filled: Bool) -> AgentMark {
        let d = open
            ? "M6 14L7.45 11.1Q7.9 10 9.24 10L20 10Q22.3 10.1 21.94 12.5L20.39 18.5Q19.9 20 18.45 20L4 20"
                + "Q2 20 2 18L2 5Q2 3 4 3L7.93 3Q8.9 3 9.59 3.9L10.41 5.1Q11 6 12.07 6L18 6Q20 6 20 8L20 10"
            : "M4 20L20 20Q22 20 22 18L22 8Q22 6 20 6L12.1 6Q11.4 6 11 5.4L9.6 3.6Q9.2 3 8.5 3L4 3"
                + "Q2 3 2 5L2 18Q2 20 4 20Z"
        return glyph([d], filled: filled)
    }

    static var branch: AgentMark {
        glyph([
            "M6 3L6 15",
            "M21 6C21 7.657 19.657 9 18 9C16.343 9 15 7.657 15 6C15 4.343 16.343 3 18 3C19.657 3 21 4.343 21 6Z",
            "M9 18C9 19.657 7.657 21 6 21C4.343 21 3 19.657 3 18C3 16.343 4.343 15 6 15C7.657 15 9 16.343 9 18Z",
            "M18 9C18 13.97 13.97 18 9 18",
        ], filled: false)
    }

    private static func glyph(_ paths: [String], filled: Bool) -> AgentMark {
        AgentMark(
            x: 0, y: 0, width: 24, height: 24,
            shapes: paths.map {
                MarkShape(d: $0, fill: filled, evenOdd: false, stroke: filled ? 0 : 2, round: true, opacity: 1)
            })
    }
}

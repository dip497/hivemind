import Foundation

/// What the agent said, which is markdown, as the core reads it (spec/markdown.md), made ready to
/// draw: read once, when the entry comes. A link is one only where the core found an https address.
enum ChatMarkdown {
    /// Blocks as drawn: one, or the blocks of a quote, set in after a bar.
    indirect enum Piece: Equatable {
        case block(TextBlock)
        case quote([Piece])
    }

    static func pieces(_ said: String) -> [Piece] {
        pieces(markdown(text: said), quote: 0)
    }

    /// `blocks`, those in a quote deeper than `quote` gathered into it.
    static func pieces(_ blocks: [TextBlock], quote: UInt32) -> [Piece] {
        var pieces: [Piece] = []
        var at = 0
        while at < blocks.count {
            if blocks[at].quote > quote {
                var end = at
                while end < blocks.count && blocks[end].quote > quote { end += 1 }
                pieces.append(.quote(Self.pieces(Array(blocks[at..<end]), quote: quote + 1)))
                at = end
            } else {
                pieces.append(.block(blocks[at]))
                at += 1
            }
        }
        return pieces
    }

    /// Runs as SwiftUI's Text draws them: their styles as inline intents, a link as one it opens.
    static func text(_ runs: [TextRun]) -> AttributedString {
        var text = AttributedString()
        for run in runs {
            // An image by its words: nothing is fetched to draw it.
            var piece = AttributedString(run.image ? "🖼 \(run.text)" : run.text)
            var intent: InlinePresentationIntent = []
            if run.strong { intent.insert(.stronglyEmphasized) }
            if run.emphasis { intent.insert(.emphasized) }
            if run.strike { intent.insert(.strikethrough) }
            if run.code { intent.insert(.code) }
            if !intent.isEmpty { piece.inlinePresentationIntent = intent }
            if let link = run.link { piece.link = URL(string: link) }
            text.append(piece)
        }
        return text
    }

    /// What starts a list's item: a bullet, its number, or whether it is done.
    static func marker(_ marker: ListMarker?) -> String {
        switch marker {
        case nil: return ""
        case .bullet: return "•"
        case .number(let n): return "\(n)."
        case .task(let done): return done ? "☑" : "☐"
        }
    }
}

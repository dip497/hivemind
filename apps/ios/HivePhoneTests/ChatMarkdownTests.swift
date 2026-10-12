import XCTest
@testable import HivePhone

/// What the agent said, in markdown, as the chat draws it (spec/markdown.md): the core reads it,
/// and what is held here is what the app makes of its blocks: styled text, links that open only
/// https addresses, markers, and quotes gathered to be set in.
final class ChatMarkdownTests: XCTestCase {
    /// The one block `markdown` is, outside any quote.
    private func block(_ markdown: String) throws -> TextBlock {
        let pieces = ChatMarkdown.pieces(markdown)
        guard pieces.count == 1, case .block(let block) = pieces[0] else {
            throw NotOneBlock(pieces: pieces)
        }
        return block
    }

    private struct NotOneBlock: Error {
        let pieces: [ChatMarkdown.Piece]
    }

    private func runs(_ block: TextBlock) -> [TextRun] {
        switch block.kind {
        case .paragraph(let runs), .heading(_, let runs): return runs
        default: return []
        }
    }

    /// Each part of `text` with its inline intent, when it has one.
    private func styled(_ text: AttributedString) -> [String: InlinePresentationIntent] {
        var styled: [String: InlinePresentationIntent] = [:]
        for run in text.runs {
            if let intent = run.inlinePresentationIntent { styled[String(text[run.range].characters)] = intent }
        }
        return styled
    }

    private func links(_ text: AttributedString) -> [String: String] {
        var links: [String: String] = [:]
        for run in text.runs {
            if let link = run.link { links[String(text[run.range].characters)] = link.absoluteString }
        }
        return links
    }

    func testEmphasisStrikethroughStrongAndCodeAreTheirIntents() throws {
        let text = ChatMarkdown.text(runs(try block("a *it* ~~gone~~ **bold** `x()` 2*3")))

        XCTAssertEqual(String(text.characters), "a it gone bold x() 2*3")
        XCTAssertEqual(styled(text), ["it": .emphasized, "gone": .strikethrough, "bold": .stronglyEmphasized, "x()": .code])
    }

    func testAHeadingKeepsItsLevel() throws {
        let pieces = ChatMarkdown.pieces("# One\n\n### Three")

        XCTAssertEqual(pieces.map { piece -> UInt8? in
            if case .block(let b) = piece, case .heading(let level, _) = b.kind { return level }
            return nil
        }, [1, 3])
    }

    func testFencedCodeIsAsWrittenWithItsLanguage() throws {
        XCTAssertEqual(try block("```rust\nlet x = **1**;\n```").kind, .code(language: "rust", text: "let x = **1**;"))
    }

    func testATableHasItsAlignmentHeadAndRows() throws {
        guard case .table(let align, let head, let rows) = try block("| a | n |\n|:--|--:|\n| x | **1** |").kind else {
            return XCTFail("a table")
        }
        XCTAssertEqual(align, [.left, .right])
        XCTAssertEqual(head.map { String(ChatMarkdown.text($0).characters) }, ["a", "n"])
        XCTAssertEqual(styled(ChatMarkdown.text(rows[0][1])), ["1": .stronglyEmphasized])
    }

    func testOnlyAnHttpsAddressWrittenOrBareIsALink() throws {
        let text = ChatMarkdown.text(runs(try block("[site](https://example.com/a) and https://b.io/c. [x](javascript:alert(1)) [y](http://plain.io)")))

        XCTAssertEqual(String(text.characters), "site and https://b.io/c. x y")
        XCTAssertEqual(links(text), ["site": "https://example.com/a", "https://b.io/c": "https://b.io/c"])
    }

    func testListItemsHaveTheirDepthAndMarker() throws {
        let blocks = ChatMarkdown.pieces("- outer\n  - inner\n\n3. three\n- [x] done").compactMap { piece -> String? in
            guard case .block(let b) = piece else { return nil }
            return "\(b.depth) \(ChatMarkdown.marker(b.marker))"
        }

        XCTAssertEqual(blocks, ["1 •", "2 •", "1 3.", "1 ☑"])
    }

    func testAQuoteGathersItsBlocksAndAQuoteInItIsGatheredFurther() throws {
        let pieces = ChatMarkdown.pieces("> said\n>\n> > deeper\n\n---\n\nafter")

        guard pieces.count == 3, case .quote(let quoted) = pieces[0], quoted.count == 2, case .quote(let deeper) = quoted[1],
            deeper.count == 1, case .block(let rule) = pieces[1]
        else {
            return XCTFail("a quote with a quote in it, a rule, a paragraph: \(pieces)")
        }
        XCTAssertEqual(rule.kind, .rule)
    }

    func testAnImageIsItsWordsALinkOnlyWhenHttps() throws {
        let text = ChatMarkdown.text(runs(try block("![a cat](https://e.com/c.png) ![x](http://e.com/d.png)")))

        XCTAssertEqual(String(text.characters), "🖼 a cat 🖼 x")
        XCTAssertEqual(links(text), ["🖼 a cat": "https://e.com/c.png"])
    }

    func testAParagraphWhoseFirstLetterIsArabicRunsRightToLeft() throws {
        XCTAssertTrue(try block("(1) مرحبا world").rtl)
        XCTAssertFalse(try block("Hello مرحبا").rtl)
    }

    func testRawHtmlIsText() throws {
        XCTAssertEqual(String(ChatMarkdown.text(runs(try block("<b>hi</b> there"))).characters), "<b>hi</b> there")
    }
}

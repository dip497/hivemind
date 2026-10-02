import XCTest
@testable import HivePhone

/// What the agent said, in markdown, as the chat draws it (design §5.4, P7): Foundation reads the
/// markdown, keeping blocks as intents, so what is held here is what the app adds: blocks apart,
/// list items marked, code blocks drawn apart in monospace.
final class ChatMarkdownTests: XCTestCase {
    func testACodeBlockIsAPartOfItsOwnBetweenTheTextAroundIt() {
        let parts = ChatMarkdown.parts("Run this:\n\n```swift\nlet x = 1\n```\n\nThen **done**.")

        guard parts.count == 3, case .text(let before) = parts[0], case .code(let code) = parts[1],
            case .text(let after) = parts[2]
        else {
            return XCTFail("text, code, text: \(parts)")
        }
        XCTAssertEqual(String(before.characters), "Run this:")
        XCTAssertEqual(code, "let x = 1")
        XCTAssertEqual(String(after.characters), "Then done.")
    }

    func testParagraphsAndListItemsStartOnLinesOfTheirOwn() {
        let parts = ChatMarkdown.parts("First.\n\nSecond:\n\n- one\n- two")

        guard parts.count == 1, case .text(let text) = parts[0] else {
            return XCTFail("one text: \(parts)")
        }
        XCTAssertEqual(String(text.characters), "First.\n\nSecond:\n\n• one\n• two")
    }
}

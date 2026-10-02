import XCTest
@testable import HivePhone

/// The chat's log of a conversation (design §5.4, P7): what a telling adds, what a telling anew
/// replaces, each entry once by its id, and a tool's result under its use. What each change says is
/// what the chat inserts or draws again, so it is part of what is held here.
final class ChatLogTests: XCTestCase {
    func testATellingAddsItsEntriesAfterThoseShown() {
        var log = ChatLog()
        _ = log.take([personSays("e1"), agentSays("e2")], anew: true)

        let change = log.take([agentSays("e3", "Done.")], anew: false)

        XCTAssertEqual(log.rows.map(\.id), ["e1", "e2", "e3"])
        // The chat inserts that one row and lays out nothing else.
        XCTAssertFalse(change.reset)
        XCTAssertEqual(change.appended, 2..<3)
        XCTAssertEqual(change.updated, [])
    }

    func testAnewReplacesWhatWasShown() {
        var log = ChatLog()
        _ = log.take([personSays("e1"), agentUses("e2", tool: "u1")], anew: true)

        // Told anew, as after the agent began another session, or a conversation followed again
        // from the start: what it tells is all there is, even what was shown before.
        let change = log.take([agentUses("e2", tool: "u1"), agentSays("e3")], anew: true)

        XCTAssertTrue(change.reset)
        XCTAssertEqual(log.rows.map(\.id), ["e2", "e3"])
    }

    func testAnEntryIsShownOnceByItsId() {
        var log = ChatLog()
        _ = log.take([personSays("e1"), agentSays("e2")], anew: true)

        let change = log.take([agentSays("e2"), agentSays("e3")], anew: false)

        XCTAssertEqual(log.rows.map(\.id), ["e1", "e2", "e3"])
        XCTAssertEqual(change.appended, 2..<3)
    }

    func testAToolsResultFoldsUnderItsUse() {
        var log = ChatLog()
        _ = log.take([agentUses("e1", tool: "u1"), agentUses("e2", tool: "u2")], anew: true)

        let change = log.take([toolGives("e3", of: "u1", "no such file", error: true)], anew: false)

        XCTAssertEqual(log.rows.map(\.id), ["e1", "e2"])
        XCTAssertTrue(change.appended.isEmpty)
        XCTAssertEqual(change.updated, [0])
        XCTAssertEqual(
            log.rows[0].said,
            .tool(Tool(id: "u1", name: "Edit", about: "src/nav.ts"), result: ToolResult(of: "u1", text: "no such file", error: true)))

        // A result of a use told before what the log holds stands on its own.
        _ = log.take([toolGives("e4", of: "u0")], anew: false)
        XCTAssertEqual(log.rows.map(\.id), ["e1", "e2", "e4"])
        XCTAssertEqual(log.rows[2].said, .result(ToolResult(of: "u0", text: "done", error: false)))
    }
}

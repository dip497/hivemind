import XCTest
@testable import HivePhone

/// The terminal following its newest line (TerminalLines.newest, design §6.4), kept the last in
/// sight. A screen still filling from the top, in a view shorter than the session (a phone's, the
/// keyboard up), shows what was written, not the blank rows under it; a full screen, as a program
/// drawing the whole of it keeps one, rests at its bottom. Read as VoiceOver reads it, and so the
/// UI tests: the lines in sight.
final class TerminalViewTests: XCTestCase {
    @MainActor
    func testAScreenStillFillingIsFollowedWhereItIsWritten() {
        // A session 40 rows tall: the talker's lines at the top, the cursor under them, blank rows below.
        let written = ["talker> fix the nav", "heard: fix the nav", "Priya says ship it", "heard: Priya says ship it"]
        let screen = written.enumerated().map { aLine(UInt64($0.offset), $0.element) }
            + (UInt64(written.count)..<40).map { aLine($0, "") }
        let terminal = aTerminal()
        terminal.apply(anUpdate(revision: 1, rows: 40, first: 0, count: 40, cursor: 4, screen))
        terminal.layoutIfNeeded()
        XCTAssertTrue(inSight(terminal).contains("heard: Priya says ship it"), "what was written: \(inSight(terminal))")
    }

    @MainActor
    func testAFullScreenIsFollowedAtItsBottom() {
        // A program drawing the whole screen: its input box, with the cursor in it, above its status.
        let terminal = aTerminal()
        terminal.apply(anUpdate(revision: 1, rows: 40, first: 0, count: 40, cursor: 36, (UInt64(0)..<40).map { aLine($0, "row \($0)") }))
        terminal.layoutIfNeeded()
        XCTAssertTrue(inSight(terminal).hasSuffix("row 39"), "its last line the last in sight: \(inSight(terminal))")
    }

    /// A terminal a few lines tall, the session's 80 columns fitted to a phone's width.
    @MainActor
    private func aTerminal() -> TerminalView {
        let terminal = TerminalView()
        terminal.frame = CGRect(x: 0, y: 0, width: 320, height: 60)
        return terminal
    }

    @MainActor
    private func inSight(_ terminal: TerminalView) -> String {
        terminal.accessibilityValue ?? ""
    }
}

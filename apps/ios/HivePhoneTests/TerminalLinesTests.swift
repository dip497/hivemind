import XCTest
@testable import HivePhone

/// The lines the terminal holds of one watch (design §5.3): an update replaces only the lines it
/// carries, so only those are drawn again; lines older than the core keeps are let go of when the
/// terminal says so; a new width is told, for the terminal to fit it; and the newest line, which
/// the terminal keeps in sight while it follows (§6.4).
final class TerminalLinesTests: XCTestCase {
    func testAnUpdateChangesOnlyTheLinesItCarries() {
        var lines = TerminalLines()
        _ = lines.apply(anUpdate(revision: 1, first: 0, count: 3, [aLine(0, "zero"), aLine(1, "one"), aLine(2, "two")]))

        let changes = lines.apply(anUpdate(revision: 2, first: 0, count: 4, [aLine(1, "one, again"), aLine(3, "three")]))

        XCTAssertEqual(changes.lines, [1, 3])
        XCTAssertEqual(lines.revision, 2)
        XCTAssertEqual(lines.end, 4)
        XCTAssertEqual(lines[0]?.text, "zero")
        XCTAssertEqual(lines[1]?.text, "one, again")
        XCTAssertEqual(lines[2]?.text, "two")
        XCTAssertEqual(lines[3]?.text, "three")
    }

    func testTrimmingLetsTheOlderLinesGo() {
        var lines = TerminalLines()
        _ = lines.apply(anUpdate(revision: 1, first: 0, count: 5, (UInt64(0)..<5).map { aLine($0, "line \($0)") }))
        // The core now keeps lines 3 to 5.
        _ = lines.apply(anUpdate(revision: 2, first: 3, count: 6, [aLine(5, "line 5")]))
        XCTAssertEqual(lines.origin, 0, "lines the core let go of are held until the terminal lets them go")

        XCTAssertEqual(lines.trim(below: lines.coreFirst), 3)

        XCTAssertEqual(lines.origin, 3)
        XCTAssertEqual(lines.count, 3)
        XCTAssertNil(lines[2])
        XCTAssertEqual(lines[3]?.text, "line 3")
        XCTAssertEqual(lines[5]?.text, "line 5")
    }

    func testANewWidthIsTold() {
        var lines = TerminalLines()
        XCTAssertTrue(lines.apply(anUpdate(revision: 1, cols: 80, first: 0, count: 0, [])).resized)
        XCTAssertFalse(lines.apply(anUpdate(revision: 2, cols: 80, first: 0, count: 0, [])).resized)
        XCTAssertTrue(lines.apply(anUpdate(revision: 3, cols: 120, first: 0, count: 0, [])).resized)
    }

    func testTheNewestLineIsTheNewerOfTheCursorsAndTheLastWritten() {
        // A session 40 rows tall (a line that draws nothing comes with no text).
        let filling = (UInt64(0)..<40).map { aLine($0, $0 < 4 ? "line \($0)" : "") }
        let full = (UInt64(0)..<40).map { aLine($0, "row \($0)") }
        let blank = (UInt64(0)..<40).map { aLine($0, "") }
        // What the screen holds, where its cursor is and whether it shows; its newest line.
        let cases: [(String, [ScreenLine], UInt64, Bool, UInt64?)] = [
            ("output at the top, the cursor under it", filling, 4, true, 4),
            ("the cursor further down than anything written", filling, 30, true, 30),
            ("the cursor hidden at the bottom, as a program drawing leaves it", filling, 39, false, 3),
            ("a full screen, the cursor in an input box above its last lines", full, 36, true, 39),
            ("nothing written, the cursor hidden", blank, 0, false, nil),
        ]
        for (name, screen, cursor, shown, newest) in cases {
            var lines = TerminalLines()
            _ = lines.apply(anUpdate(revision: 1, rows: 40, first: 0, count: 40, cursor: cursor, cursorShown: shown, screen))
            XCTAssertEqual(lines.newest, newest, name)
        }
    }
}

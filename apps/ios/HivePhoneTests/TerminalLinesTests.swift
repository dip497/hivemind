import XCTest
@testable import HivePhone

/// The lines the terminal holds of one watch (design §5.3): an update replaces only the lines it
/// carries, so only those are drawn again; lines older than the core keeps are let go of when the
/// terminal says so; and a new width is told, for the terminal to fit it.
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
}

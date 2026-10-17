import XCTest
@testable import HivePhone

/// The terminal's packed runs, read as design §5.3 lays them out: the bytes are spelled out here,
/// because the layout is the contract between the core and both apps.
final class PackedRunsTests: XCTestCase {
    func testARunReadsAsTheCoreLaysItOut() throws {
        let bytes: [UInt8] = [
            0x02, 0x00, // start 2
            0x03, 0x00, // len 3
            0x0a, 0x00, // col 10
            0x09, 0x01, // flags: bold (bit 0), underline (bit 3), wide (bit 8)
            0x05, 0x00, 0x00, 0x01, // fg: palette, index 5
            0x33, 0x22, 0x11, 0x02, // bg: RGB #112233
        ]
        let runs = PackedRuns.decode(Data(bytes))

        XCTAssertEqual(runs.count, 1)
        let run = try XCTUnwrap(runs.first)
        XCTAssertEqual([run.start, run.length, run.col], [2, 3, 10])
        XCTAssertEqual([run.bold, run.underline, run.wide], [true, true, true])
        XCTAssertEqual([run.dim, run.italic, run.inverse, run.strikethrough, run.hidden], [false, false, false, false, false])
        XCTAssertEqual(TerminalColor(run.fg), .palette(5))
        XCTAssertEqual(TerminalColor(run.bg), .rgb(0x11, 0x22, 0x33))
    }

    func testRunsFollowOneAnotherEverySixteenBytes() {
        var bytes: [UInt8] = []
        // start 0, len 4, col 0, no flags, the default colours (top byte 0)
        bytes += [0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        // start 4, len 1, col 4, italic (bit 2) and inverse (bit 4), fg RGB #ff8000, bg default
        bytes += [0x04, 0x00, 0x01, 0x00, 0x04, 0x00, 0x14, 0x00, 0x00, 0x80, 0xff, 0x02, 0x00, 0x00, 0x00, 0x00]
        let runs = PackedRuns.decode(Data(bytes))

        XCTAssertEqual(runs.count, 2)
        XCTAssertEqual([runs[0].start, runs[0].length, runs[0].col], [0, 4, 0])
        XCTAssertEqual(TerminalColor(runs[0].fg), .standard)
        XCTAssertEqual([runs[1].start, runs[1].length, runs[1].col], [4, 1, 4])
        XCTAssertEqual([runs[1].italic, runs[1].inverse, runs[1].bold, runs[1].wide], [true, true, false, false])
        XCTAssertEqual(TerminalColor(runs[1].fg), .rgb(0xff, 0x80, 0x00))
        XCTAssertEqual(TerminalColor(runs[1].bg), .standard)
    }
}

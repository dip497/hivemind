import XCTest
@testable import HivePhone

/// A frame's colour as the desktop keeps it, read for its folder on Home.
final class FrameColorTests: XCTestCase {
    private func assertColor(_ text: String, _ red: Double, _ green: Double, _ blue: Double, file: StaticString = #filePath, line: UInt = #line) {
        guard let color = FrameColor.read(text) else {
            return XCTFail("\(text) is read", file: file, line: line)
        }
        XCTAssertEqual(color.red, red, accuracy: 0.01, "\(text): red", file: file, line: line)
        XCTAssertEqual(color.green, green, accuracy: 0.01, "\(text): green", file: file, line: line)
        XCTAssertEqual(color.blue, blue, accuracy: 0.01, "\(text): blue", file: file, line: line)
    }

    func testHexColoursAreReadWholeAndShort() {
        assertColor("#3b82f6", 59 / 255, 130 / 255, 246 / 255)
        assertColor("#FFF", 1, 1, 1)
    }

    func testOklchColoursAreTheSRGBTheyName() {
        // sRGB's red, green and blue, as OKLCH writes them; lightness as a number or a percentage.
        assertColor("oklch(0.62796 0.25768 29.2339)", 1, 0, 0)
        assertColor("oklch(86.644% 0.29483 142.4953)", 0, 1, 0)
        assertColor("oklch(0.45201 0.31321 264.052 / 0.5)", 0, 0, 1)
    }

    func testAnythingElseIsNoColour() {
        for text in ["", "blue", "#3b82f", "#3b82f6ff", "oklch(0.7 0.1)", "rgb(1, 2, 3)"] {
            XCTAssertNil(FrameColor.read(text), "\(text) is no colour")
        }
    }
}

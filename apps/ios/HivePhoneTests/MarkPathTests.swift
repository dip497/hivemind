import SwiftUI
import XCTest
@testable import HivePhone

/// An agent's mark as the core sends it (`MarkShape.d`: absolute `M L C Q Z`), read into a path.
final class MarkPathTests: XCTestCase {
    private func elements(_ d: String) -> [Path.Element]? {
        guard let path = MarkPath.read(d) else { return nil }
        var out: [Path.Element] = []
        path.forEach { out.append($0) }
        return out
    }

    func testEachCommandBecomesItsElementWithItsPointsInSVGOrder() {
        XCTAssertEqual(elements("M1 2L3 4Q5 6 7 8C9 10 11 12 13 14Z"), [
            .move(to: CGPoint(x: 1, y: 2)),
            .line(to: CGPoint(x: 3, y: 4)),
            .quadCurve(to: CGPoint(x: 7, y: 8), control: CGPoint(x: 5, y: 6)),
            .curve(to: CGPoint(x: 13, y: 14), control1: CGPoint(x: 9, y: 10), control2: CGPoint(x: 11, y: 12)),
            .closeSubpath,
        ])
    }

    func testNumbersAreReadAsSVGWritesThemPackedTogether() {
        // A sign or a second point starts the next number; an exponent belongs to its number;
        // pairs after a move are lines, as are pairs after a line.
        XCTAssertEqual(elements("M-1.5-2L.5.5 1e1,2E-1M0 0 4 0 4 4Z"), [
            .move(to: CGPoint(x: -1.5, y: -2)),
            .line(to: CGPoint(x: 0.5, y: 0.5)),
            .line(to: CGPoint(x: 10, y: 0.2)),
            .move(to: CGPoint(x: 0, y: 0)),
            .line(to: CGPoint(x: 4, y: 0)),
            .line(to: CGPoint(x: 4, y: 4)),
            .closeSubpath,
        ])
    }

    func testAPathWithAnythingElseIsNotDrawnAtAll() {
        for d in [
            "",
            "m0 0l1 1",  // relative
            "M0 0H5",  // a command the core never sends
            "M0 0A1 1 0 0 1 2 2",
            "L1 1",  // no move first
            "M0 0L1",  // a point short
            "M0 0Z3 4",  // numbers with no command
            "M0 0Lx 1",
        ] {
            XCTAssertNil(MarkPath.read(d), "\(d) is not read")
        }
    }
}

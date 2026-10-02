import XCTest
@testable import HivePhone

/// What the Needs tab offers and says (design §6.2), from records built here.
final class NeedsTests: XCTestCase {
    func testEachWaitOffersTheAnswersItCanTake() {
        let cases: [(Waiting, Answers)] = [
            (aWait(.permission, decide: true), .decide),
            // A permission the device cannot decide in two answers has more choices than Allow and
            // Deny: the person answers it in the agent's terminal.
            (aWait(.permission, decide: false), .terminal),
            (aWait(.plan), .plan),
            (aWait(.question), .reply),
            (aWait(.other), .terminal),
        ]
        for (pending, offered) in cases {
            XCTAssertEqual(Answers(pending), offered, "\(pending.kind), decide: \(pending.decide)")
        }
    }

    func testADeviceIsAwayOnceTheCoreFoundItAwayAndSaysWhenItWasLastHeard() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let fiveMinutesAgo: UInt64 = (1_700_000_000 - 5 * 60) * 1000
        let devices = [
            Device(id: "d1", name: "desk", kind: .computer, reachable: false, awaySince: fiveMinutesAgo, heardAt: fiveMinutesAgo),
            // Not dialled yet, a moment after the app came back: not away.
            Device(id: "d2", name: "laptop", kind: .computer, reachable: false, awaySince: nil, heardAt: fiveMinutesAgo),
            Device(id: "d3", name: "box", kind: .host, reachable: true, awaySince: nil, heardAt: fiveMinutesAgo),
        ]

        let away = NeedsSummary.away(devices)

        XCTAssertEqual(away.map(\.id), ["d1"])
        XCTAssertEqual(NeedsSummary.awayLine(away[0], now: now), "desk is away · last heard 5 min ago")
    }
}

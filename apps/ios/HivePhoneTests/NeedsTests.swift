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
            // Questions its device cannot choose for are answered with a line.
            (aWait(.question, questions: [color], choose: false), .reply),
            (aWait(.question, questions: [color], choose: true), .choose),
            (aWait(.question, questions: [sizes], choose: true), .questions),
            (aWait(.question, questions: [color, color], choose: true), .questions),
            (aWait(.other), .terminal),
        ]
        for (pending, offered) in cases {
            XCTAssertEqual(Answers(pending), offered, "\(pending.kind), decide: \(pending.decide), \(pending.questions.count) questions")
        }
    }

    func testSeveralQuestionsAreEachAnsweredInTheirPlace() {
        var picks = QuestionPicks([color, sizes])

        picks.pick(2, of: 1)
        picks.pick(0, of: 1)
        XCTAssertFalse(picks.answered, "the first question has no answer yet")
        picks.pick(0, of: 0)
        picks.pick(1, of: 0)

        XCTAssertTrue(picks.answered)
        XCTAssertEqual(picks.answers, [.chosen(options: [1]), .chosen(options: [0, 2])])

        picks.own[0] = " Teal "
        XCTAssertEqual(picks.answers, [.text(text: "Teal"), .chosen(options: [0, 2])])
    }

    private let color = aQuestion("Which color?", "Red", "Green", "Blue")
    private let sizes = aQuestion("Which sizes?", "Small", "Medium", "Large", many: true)

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

    func testADeviceThatHasNotSaidWhatWaitsThereIsAskedAndNothingIsSaidToWaitUntilItHas() {
        let heard: UInt64 = 1_700_000_000_000
        // Reached: it told the workspaces it holds, and not yet what waits there.
        let desk = Device(id: "d1", name: "desk", kind: .computer, reachable: true, awaySince: nil, heardAt: heard, answeredAt: nil)
        let laptop = Device(id: "d2", name: "laptop", kind: .computer, reachable: true, awaySince: nil, heardAt: heard, answeredAt: heard)
        // Found away before it said: its own line says so.
        let box = Device(id: "d3", name: "box", kind: .host, reachable: false, awaySince: heard, heardAt: nil, answeredAt: nil)

        let asking = NeedsSummary.asking([desk, laptop, box])

        XCTAssertEqual(asking.map(\.id), ["d1"])
        XCTAssertEqual(NeedsSummary.askingLine(asking[0]), "Asking desk…")
        XCTAssertNil(NeedsSummary.nothing(working: 0, asking: asking))
        XCTAssertEqual(NeedsSummary.nothing(working: 2, asking: []), "Nothing needs you. 2 agents working.")
    }
}

import XCTest
@testable import HivePhone

/// What a community view shown on the phone does with what its page posts, and when its session
/// ends (design §4, §5.5, §6.1).
final class ViewPageTests: XCTestCase {
    func testWhatStartsOrClosesSomethingWaitsForThePhonesLockAndTheRestGoesAtOnce() {
        // As the view SDK posts them (client.ts): starting an agent, selecting a tile, being ready.
        let start = #"{"type":"command","name":"spawnAgent","args":[null,null,{}]}"#
        let select = #"{"type":"command","name":"selectTile","args":["t1"]}"#
        let ready = #"{"type":"ready","v":1}"#

        guard case .afterLock(let reason) = ViewPost(start, view: "Priya's phone board") else {
            return XCTFail("starting an agent from a view asks the phone's lock first")
        }
        XCTAssertTrue(reason.contains("Priya's phone board"), reason)
        XCTAssertEqual(ViewPost(select, view: "Priya's phone board"), .now)
        XCTAssertEqual(ViewPost(ready, view: "Priya's phone board"), .now)
    }

    func testStartingAgainGoesOnAndAnyOtherEndSaysWhyInTheAppsWords() {
        let cases: [(ViewEnded, ViewEnd)] = [
            (.restarting, .again),
            (.disabled(why: "message flood: >200 messages in one second"),
             .over("desk turned this view off: message flood: >200 messages in one second")),
            (.refused(why: "no view board here works on a phone"), .over("desk said no: no view board here works on a phone")),
            (.notHeld, .over("Its workspace is not on desk now.")),
            (.unpaired, .over("desk is not one of your devices now.")),
        ]
        for (ended, end) in cases {
            XCTAssertEqual(ViewEnd(ended, device: "desk"), end, "\(ended)")
        }
    }
}

import XCTest
@testable import HivePhone

/// What the person chose to see on Home, kept phone-wide and given to the core on every call.
final class HomeViewChoicesTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: HomeViewChoices.storageKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: HomeViewChoices.storageKey)
        super.tearDown()
    }

    func testWhatIsSavedIsWhatTheNextLaunchLoadsAndGivesTheCore() {
        XCTAssertEqual(HomeViewChoices.load(), HomeViewChoices(), "nothing saved yet: the defaults")

        var kept = HomeViewChoices()
        kept.status = "needs-you"
        kept.activity = "today"
        kept.groupBy = "agent"
        kept.sortBy = "name"
        kept.fold("f:w1/frame-1")
        kept.saw("t:tile-1", at: 1_700_000_000_000)
        kept.save()

        let loaded = HomeViewChoices.load()
        XCTAssertEqual(loaded, kept)
        XCTAssertEqual(
            loaded.choices(),
            HomeChoices(
                status: "needs-you", activity: "today", groupBy: "agent", sortBy: "name",
                folded: ["f:w1/frame-1"], seen: ["t:tile-1": 1_700_000_000_000],
                offsetMinutes: Int32(TimeZone.current.secondsFromGMT() / 60)))
    }

    func testFoldingAgainUnfolds() {
        var choices = HomeViewChoices()
        choices.fold("p:m/w1/")
        choices.fold("f:w1/frame-1")
        choices.fold("p:m/w1/")
        XCTAssertEqual(choices.folded, ["f:w1/frame-1"])
    }

    func testTheViewDotShowsWhileAnyChoiceIsNotItsDefaultAndResetKeepsFoldsAndSeen() {
        var choices = HomeViewChoices()
        choices.fold("f:w1/frame-1")
        choices.saw("t:tile-1", at: 5)
        XCTAssertTrue(choices.isDefault, "folds and what was seen are not View choices")
        for group in ViewChoiceGroup.all {
            var changed = choices
            changed[keyPath: group.choice] = group.options.last!.id
            XCTAssertFalse(changed.isDefault, "\(group.title) changed shows the dot")
            changed.resetView()
            XCTAssertTrue(changed.isDefault, "\(group.title) back to its default")
            XCTAssertEqual(changed, choices, "reset keeps what is folded and seen")
        }
    }

    func testOnlyTheMostRecentlyOpenedTilesAreRemembered() {
        var choices = HomeViewChoices()
        for n in 0...HomeViewChoices.seenLimit {
            choices.saw("t:\(n)", at: UInt64(1000 + n))
        }
        XCTAssertEqual(choices.seen.count, HomeViewChoices.seenLimit)
        XCTAssertNil(choices.seen["t:0"], "the longest unopened is forgotten")
        XCTAssertEqual(choices.seen["t:\(HomeViewChoices.seenLimit)"], UInt64(1000 + HomeViewChoices.seenLimit))
    }
}

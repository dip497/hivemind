import XCTest

/// The app, with its real core, on a phone paired with nothing (design §6.1): it opens on Pair, and
/// text that is not a pairing link is refused with what the core said of it.
final class PairUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @MainActor
    func testItOpensOnPairAndRefusesAPastedTextThatIsNotALink() {
        let app = XCUIApplication()
        app.launch()

        let link = app.textFields["pair.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 30), "the app opens on Pair")
        link.tap()
        // Typed into the field the person pastes into; the return key pairs, as the Pair button does.
        link.typeText("not-a-pairing-link\n")

        let error = app.staticTexts["pair.error"]
        XCTAssertTrue(error.waitForExistence(timeout: 30), "a refusal is shown")
        XCTAssertFalse(error.label.isEmpty)
        XCTAssertTrue(link.exists, "still on Pair")
    }
}

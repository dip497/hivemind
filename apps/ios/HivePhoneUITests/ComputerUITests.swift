import XCTest

/// The app against a real computer (design §7): it pastes the link the computer's Settings → Devices
/// → Pair a phone shows, pairs, and is the person's; finds the computer and its agent among the
/// agents; opens the agent and reads its line in its terminal, then what it and the person said in
/// its chat; and sends it a message from the reply box, which it answers in the chat and in its
/// terminal, still followed. Then the community view the computer offers the phone (P8): its page,
/// served by the computer, shows the computer's agent; what the view may do at once (selecting a
/// tile) the computer answers; what would start an agent waits for the phone's lock, which a
/// simulator does not have, and the app says so. Run by
/// apps/desktop/tests/e2e/phone-app.spec.ts (PHONE_APP=ios), which hands it the link and what to find
/// there: xcodebuild gives the test runner each `TEST_RUNNER_<NAME>` it was given as `<NAME>`.
/// Without a link it skips itself, so the app's own UI test run is unchanged. A computer's network,
/// a terminal and a conversation over it are slow on a CI simulator: every wait is long.
final class ComputerUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @MainActor
    func testItPairsWithTheComputerAndDrivesItsAgent() throws {
        let told = ProcessInfo.processInfo.environment
        guard let link = told["PAIR_LINK"], !link.isEmpty else {
            throw XCTSkip("no computer to pair with: apps/desktop/tests/e2e/phone-app.spec.ts runs this with PAIR_LINK")
        }
        func given(_ name: String) throws -> String {
            try XCTUnwrap(told[name], "\(name) is given with PAIR_LINK")
        }
        let person = try given("PAIR_PERSON")
        let computer = try given("PAIR_COMPUTER")
        let agent = try given("PAIR_AGENT")
        let line = try given("PAIR_LINE")
        let said = try given("PAIR_SAID")
        let message = try given("PAIR_MESSAGE")
        let answer = try given("PAIR_ANSWER")
        let heard = try given("PAIR_HEARD")
        let view = try given("PAIR_VIEW")
        let viewAgent = try given("PAIR_VIEW_AGENT")
        let selected = try given("PAIR_VIEW_SELECTED")

        let app = XCUIApplication()
        app.launch()

        // Paired by the link, pasted as the computer shows it: the phone is the person's now.
        let field = app.textFields["pair.link"]
        XCTAssertTrue(field.waitForExistence(timeout: 60), "the app opens on Pair")
        field.tap()
        field.typeText(link)
        XCTAssertEqual(field.value as? String, link, "the link went in whole")
        // The return key pairs, as the Pair button does.
        field.typeText("\n")
        XCTAssertTrue(showing("This phone is \(person)'s.", in: app).waitForExistence(timeout: 120), "paired, as \(person)'s")
        app.buttons["Continue"].tap()

        // The computer, and its agent, among the agents.
        let agents = app.buttons["Agents"].firstMatch
        XCTAssertTrue(agents.waitForExistence(timeout: 30), "the tabs are shown")
        agents.tap()
        XCTAssertTrue(showing(computer, in: app).waitForExistence(timeout: 120), "\(computer) is among the agents' devices")
        let row = showing(agent, in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 120), "\(agent) is among the agents")
        row.tap()

        // Its terminal: the line the agent printed, as its screen has it.
        let terminalTab = app.segmentedControls.buttons["Terminal"]
        XCTAssertTrue(terminalTab.waitForExistence(timeout: 30), "the agent's screen is shown")
        terminalTab.tap()
        let terminal = app.descendants(matching: .any)["agent.terminal"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 30), "its terminal is shown")
        XCTAssertEqual(shows(line, terminal), .completed, "its terminal shows \(line)")

        // What it and the person said to each other.
        app.segmentedControls.buttons["Chat"].tap()
        XCTAssertTrue(showing(said, in: app).waitForExistence(timeout: 60), "its chat shows \(said)")

        // A message from the reply box: the agent hears it, and answers.
        let reply = app.textFields["agent.reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 30), "the reply box is there")
        reply.tap()
        reply.typeText(message)
        // The app's Send, by its identifier: the keyboard's return key is Send too (the reply box's
        // submit label), and a tap by "Send" finds both.
        app.buttons["agent.send"].tap()
        XCTAssertTrue(showing(answer, in: app).waitForExistence(timeout: 60), "the agent answered: \(answer)")

        // Its terminal, followed all the while the chat was: what it printed on hearing it.
        terminalTab.tap()
        XCTAssertEqual(shows(heard, terminal), .completed, "its terminal shows \(heard)")

        // The reply box gives the keyboard back (nothing is left in it to send), so that the tabs
        // under the keyboard can be tapped.
        if app.keyboards.firstMatch.exists {
            reply.typeText("\n")
            XCTAssertEqual(gone(app.keyboards.firstMatch), .completed, "the keyboard went")
        }

        // The community views the computer offers the phone, and the one it offers for this test.
        let viewsTab = app.buttons["Views"].firstMatch
        XCTAssertTrue(viewsTab.waitForExistence(timeout: 30), "the Views tab is there")
        viewsTab.tap()
        let offered = showing(view, in: app)
        XCTAssertTrue(offered.waitForExistence(timeout: 120), "\(view) is among the views")
        offered.tap()

        // Its page, as the computer serves it, laid out for a phone, with the computer's agent on it.
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 60), "the view's page is shown")
        XCTAssertTrue(inPage("On a phone", app).waitForExistence(timeout: 120), "the view is told it is on a phone")
        XCTAssertTrue(inPage(viewAgent, app).waitForExistence(timeout: 60), "the view shows \(viewAgent)")

        // What the view may do at once: select a tile, which the computer answers.
        let select = app.webViews.buttons["Select"]
        XCTAssertTrue(select.waitForExistence(timeout: 30), "the view offers Select")
        select.tap()
        XCTAssertTrue(inPage(selected, app).waitForExistence(timeout: 60), "the computer answered: \(selected)")

        // What would start an agent waits for the phone's lock; a simulator has none, and the app
        // says so rather than starting it.
        let start = app.webViews.buttons["Start an agent"]
        XCTAssertTrue(start.waitForExistence(timeout: 30), "the view offers Start an agent")
        start.tap()
        let notice = app.staticTexts["view.notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 30), "the phone's lock was asked first")
        XCTAssertTrue(notice.label.contains("passcode"), "the app says why: \(notice.label)")
    }

    /// Waits a minute at most for `terminal` to show `line` among the lines in sight.
    @MainActor
    private func shows(_ line: String, _ terminal: XCUIElement) -> XCTWaiter.Result {
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", line), object: terminal)
        return XCTWaiter.wait(for: [shown], timeout: 60)
    }

    /// Waits half a minute at most for `element` to go.
    @MainActor
    private func gone(_ element: XCUIElement) -> XCTWaiter.Result {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter.wait(for: [gone], timeout: 30)
    }

    /// The first element of a view's page whose label has `text` in it, whatever kind it is.
    @MainActor
    private func inPage(_ text: String, _ app: XCUIApplication) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// The first element whose label has `text` in it, whatever kind it is: a row's text may be its
    /// own element or part of the row's.
    @MainActor
    private func showing(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
    }
}

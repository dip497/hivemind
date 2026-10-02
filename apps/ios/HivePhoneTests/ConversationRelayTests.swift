import XCTest
@testable import HivePhone

/// The relay that takes a conversation's tellings to the main thread (design §5.4): unlike frames,
/// each says something new, so none is dropped; they arrive in the order told, a burst in one pass.
final class ConversationRelayTests: XCTestCase {
    @MainActor
    func testEverythingToldArrivesInOrderInOnePass() {
        let taken = Taken()
        let relay = ConversationRelay { told in taken.passes.append(told) }
        // Told on a thread of the core's while the main thread waits, not yet free to take any.
        DispatchQueue.global().sync {
            relay.said(entries: [personSays("e1")], anew: true)
            relay.said(entries: [agentSays("e2")], anew: false)
            relay.ended(why: "the device refused it")
        }
        drainMain()

        XCTAssertEqual(taken.passes, [[
            .said([personSays("e1")], anew: true),
            .said([agentSays("e2")], anew: false),
            .ended("the device refused it"),
        ]])
    }
}

/// What the main thread took, pass by pass.
@MainActor
private final class Taken {
    var passes: [[ConversationRelay.Told]] = []
}

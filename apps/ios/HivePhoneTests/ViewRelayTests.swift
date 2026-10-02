import XCTest
@testable import HivePhone

/// The relay that takes what a community view's host says to the main thread (design §5.5): every
/// message for the page, none dropped, in the order said, a burst in one pass; and starting again
/// in its place among them.
final class ViewRelayTests: XCTestCase {
    @MainActor
    func testEveryMessageReachesThePageInOrderWithStartingAgainInItsPlace() {
        let taken = Taken()
        let relay = ViewRelay { told in taken.passes.append(told) }
        // Said on a thread of the core's while the main thread waits, not yet free to take any.
        DispatchQueue.global().sync {
            relay.said(message: #"{"type":"hello"}"#)
            relay.said(message: #"{"type":"structure"}"#)
            relay.ended(why: .restarting)
            relay.said(message: #"{"type":"hello"}"#)
        }
        drainMain()

        XCTAssertEqual(taken.passes, [[
            .said(#"{"type":"hello"}"#),
            .said(#"{"type":"structure"}"#),
            .ended(.restarting),
            .said(#"{"type":"hello"}"#),
        ]])
    }
}

/// What the main thread took, pass by pass.
@MainActor
private final class Taken {
    var passes: [[ViewRelay.Told]] = []
}

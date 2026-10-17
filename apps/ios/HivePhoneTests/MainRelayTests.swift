import XCTest
@testable import HivePhone

/// The relay that takes the core's "changed" to the main thread (design §3.4): a burst is pulled
/// once, and no change is lost to the pull it lands in.
final class MainRelayTests: XCTestCase {
    @MainActor
    func testABurstOfChangesIsPulledOnce() {
        let puller = Puller(pokeDuringFirstPull: false)
        let relay: MainRelay = puller.relay
        // The main thread is busy with this test, so the whole burst lands before the hop runs.
        DispatchQueue.concurrentPerform(iterations: 64) { _ in relay.poke() }
        drainMain()

        XCTAssertEqual(puller.pulls, 1)
    }

    @MainActor
    func testAChangeDuringThePullIsPulledAgain() {
        let puller = Puller(pokeDuringFirstPull: true)
        puller.relay.poke()
        drainMain()
        drainMain()

        XCTAssertEqual(puller.pulls, 2)
    }
}

extension XCTestCase {
    /// Runs what the main queue holds now; the hops it schedules meanwhile go after.
    @MainActor
    func drainMain() {
        let drained = expectation(description: "the main queue ran what it held")
        DispatchQueue.main.async { drained.fulfill() }
        wait(for: [drained], timeout: 5)
    }
}

/// Counts the pulls; a change can land in the first one, as one from the core can.
@MainActor
private final class Puller {
    private(set) var pulls = 0
    private(set) var relay: MainRelay!

    init(pokeDuringFirstPull: Bool) {
        relay = MainRelay { [unowned self] in
            self.pulls += 1
            if pokeDuringFirstPull && self.pulls == 1 {
                self.relay.poke()
            }
        }
    }
}

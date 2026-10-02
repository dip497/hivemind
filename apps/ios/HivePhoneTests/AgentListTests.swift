import XCTest
@testable import HivePhone

/// The Agents tab (design §6.3), from records built here.
final class AgentListTests: XCTestCase {
    func testSectionsCutWhereTheDeviceOrTheWorkspaceChanges() {
        let agents = [
            anAgent(device: "d1", workspace: "w1", tile: "t1", name: "a", deviceName: "desk"),
            anAgent(device: "d1", workspace: "w1", tile: "t2", name: "b", deviceName: "desk"),
            // The same workspace id on another device is another workspace.
            anAgent(device: "d2", workspace: "w1", tile: "t1", name: "c", deviceName: "laptop"),
            anAgent(device: "d2", workspace: "w2", tile: "t9", name: "d", deviceName: "laptop", workspaceName: "site"),
        ]

        let sections = AgentSection.of(agents)

        XCTAssertEqual(sections.map(\.title), ["desk · hivemind", "laptop · hivemind", "laptop · site"])
        XCTAssertEqual(sections.map { $0.agents.map(\.name) }, [["a", "b"], ["c"], ["d"]])
    }

    func testStopIsOfferedOnlyWhileItWorksAndCanBeInterrupted() {
        XCTAssertTrue(AgentLook.offersStop(anAgent(state: .working, canInterrupt: true)))
        XCTAssertFalse(AgentLook.offersStop(anAgent(state: .working, canInterrupt: false)))
        // Waiting on a permission, its interrupt keys (Claude Code's: Esc) would answer "no".
        XCTAssertFalse(AgentLook.offersStop(anAgent(state: .waiting, waiting: aWait(.permission), canInterrupt: true)))
    }
}

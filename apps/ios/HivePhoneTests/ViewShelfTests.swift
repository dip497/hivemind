import XCTest
@testable import HivePhone

/// The Views tab's list (design §6 screen 9, §6.1): what each computer last said it offers for each
/// workspace it holds, in the overview's order, the rows of a computer away dimmed.
final class ViewShelfTests: XCTestCase {
    private let board = ViewInfo(id: "@priya/phone-board", name: "Priya's phone board", version: "1.0.0", page: "index.html")
    private let notes = ViewInfo(id: "notes", name: "Notes", version: "0.2.0", page: "__entry.html")

    func testEachWorkspaceOffersWhatItsComputerLastSaidAndAComputerAwayKeepsItsRowsDimmed() {
        let api = Workspace(device: "d1", id: "w1", name: "api", folder: nil)
        // The same workspace id on another computer is another workspace.
        let site = Workspace(device: "d2", id: "w1", name: "site", folder: nil)
        let heard: UInt64 = 1_700_000_000_000
        let devices = [
            Device(id: "d1", name: "desk", kind: .computer, reachable: true, awaySince: nil, heardAt: heard),
            Device(id: "d2", name: "laptop", kind: .computer, reachable: false, awaySince: heard, heardAt: heard),
        ]
        var shelf = ViewShelf()
        shelf.heard([board], in: api)
        shelf.heard([board, notes], in: site)

        let rows = shelf.rows(workspaces: [api, site], devices: devices)

        XCTAssertEqual(rows.map { "\($0.view.info.name) · \($0.view.workspaceName) · \($0.view.deviceName)" }, [
            "Priya's phone board · api · desk",
            "Priya's phone board · site · laptop",
            "Notes · site · laptop",
        ])
        XCTAssertEqual(rows.map(\.away), [false, true, true])
        // A workspace its computer holds no more offers nothing.
        XCTAssertEqual(shelf.rows(workspaces: [site], devices: devices).map(\.view.workspaceName), ["site", "site"])
    }
}

import Foundation

/// A community view one of the person's computers offers the phone, for a workspace it holds
/// (design §5.5): what its row says, and where it is shown from.
struct OfferedView: Hashable, Identifiable {
    let device: String
    let deviceName: String
    let workspace: String
    let workspaceName: String
    let info: ViewInfo
    let origin: ViewOrigin

    /// None for a view whose id no origin can carry.
    init?(_ info: ViewInfo, in workspace: Workspace, deviceName: String) {
        guard let origin = ViewOrigin(id: info.id) else { return nil }
        device = workspace.device
        self.deviceName = deviceName
        self.workspace = workspace.id
        workspaceName = workspace.name
        self.info = info
        self.origin = origin
    }

    var id: String { device + "\n" + workspace + "\n" + info.id }
}

/// One row of the Views tab: a view, dimmed while its computer is away.
struct ShelfRow: Identifiable {
    let view: OfferedView
    let away: Bool

    var id: String { view.id }
}

/// The Views tab's list (design §6 screen 9, §6.1), the index of what the phone may show: the
/// community views each of the person's computers offers the phone for each workspace it holds, as
/// it last said. A computer that does not answer keeps what it said before.
struct ViewShelf {
    /// What each workspace's computer last said it offers, by computer and workspace.
    private var said: [String: [ViewInfo]] = [:]

    mutating func heard(_ views: [ViewInfo], in workspace: Workspace) {
        said[Self.key(workspace)] = views
    }

    /// The rows: the workspaces in the overview's order, each with the views its computer said it
    /// offers, in the order it listed them; a workspace no computer holds now offers none. The
    /// rows of a computer away are dimmed.
    func rows(workspaces: [Workspace], devices: [Device]) -> [ShelfRow] {
        let away = Set(NeedsSummary.away(devices).map(\.id))
        return workspaces.flatMap { workspace -> [ShelfRow] in
            let deviceName = devices.first(where: { $0.id == workspace.device })?.name ?? workspace.device
            let offered = (said[Self.key(workspace)] ?? []).compactMap { info in
                OfferedView(info, in: workspace, deviceName: deviceName)
            }
            return offered.map { ShelfRow(view: $0, away: away.contains(workspace.device)) }
        }
    }

    private static func key(_ workspace: Workspace) -> String {
        workspace.device + "\n" + workspace.id
    }
}

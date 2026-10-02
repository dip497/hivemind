import SwiftUI

/// The community views the person's computers offer the phone (design §6 screen 9, §6.1): a row for
/// each, its workspace and computer under its name, for each workspace each computer holds, as the
/// computer last said; asked again whenever the workspaces or the computers reached change, and on
/// a pull. A computer away keeps its rows, dimmed. A row opens the view.
@MainActor
struct ViewsTab: View {
    let model: PhoneModel
    @State private var path: [OfferedView] = []
    @State private var shelf = ViewShelf()
    /// Every computer has been asked once: an empty list is nothing offered, not yet known.
    @State private var asked = false

    var body: some View {
        NavigationStack(path: $path) {
            let rows = shelf.rows(workspaces: model.overview.workspaces, devices: model.overview.devices)
            List {
                ForEach(NeedsSummary.away(model.overview.devices), id: \.id) { device in
                    Label("\(device.name) is away", systemImage: "wifi.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(rows) { row in
                    NavigationLink(value: row.view) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.view.info.name)
                                .lineLimit(1)
                            Text("\(row.view.workspaceName) · \(row.view.deviceName)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .disabled(row.away)
                    .opacity(row.away ? 0.5 : 1)
                }
            }
            .overlay {
                if rows.isEmpty {
                    if asked {
                        ContentUnavailableView(
                            "No views yet",
                            systemImage: "square.grid.2x2",
                            description: Text("A community view that works on a phone, installed on your computer, shows here."))
                    } else {
                        ProgressView()
                    }
                }
            }
            .refreshable { await ask() }
            .task(id: Asking(model.overview)) { await ask() }
            .navigationTitle("Views")
            .navigationDestination(for: OfferedView.self) { offered in
                ViewScreen(model: model, offered: offered)
            }
        }
    }

    /// Asks each computer, all at once, what it offers for each workspace it holds: what one answers
    /// takes the place of what it said before; one that does not answer keeps it.
    private func ask() async {
        let phone = model.phone
        let workspaces = model.overview.workspaces
        await withTaskGroup(of: (workspace: Workspace, views: [ViewInfo]?).self) { group in
            for workspace in workspaces {
                group.addTask {
                    let views = try? await phone.views(device: workspace.device, workspace: workspace.id)
                    return (workspace: workspace, views: views)
                }
            }
            for await answer in group {
                if let views = answer.views {
                    shelf.heard(views, in: answer.workspace)
                }
            }
        }
        asked = true
    }
}

/// What the views are asked again on: the workspaces the computers hold, and the computers reached.
private struct Asking: Equatable {
    let workspaces: [String]
    let reached: [String]

    init(_ overview: Overview) {
        workspaces = overview.workspaces.map { $0.device + "\n" + $0.id }
        reached = overview.devices.filter(\.reachable).map(\.id)
    }
}

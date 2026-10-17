import SwiftUI

/// Settings, opened from Home's gear: whose the phone is, each of the person's devices it is paired
/// with, reachable or away, unpairing one and pairing another (design §6.7); then the community
/// views the person's computers offer the phone (design §6 screen 9, §6.1): a row for each, its
/// workspace and computer under its name, for each workspace each computer holds, as the computer
/// last said; asked again whenever the workspaces or the computers reached change, and on a pull. A
/// computer away keeps its rows, dimmed and saying so, and they do not open. A row opens the view
/// (the index of what the app offers, Apple's guideline 4.7.4).
@MainActor
struct SettingsScreen: View {
    let model: PhoneModel
    let pairAnother: () -> Void
    @State private var unpairing: Device? = nil
    @State private var confirming = false
    @State private var shelf = ViewShelf()
    /// Every computer has been asked once: an empty list is nothing offered, not yet known.
    @State private var asked = false

    var body: some View {
        TimelineView(.everyMinute) { context in
            List {
                Section {
                    if let person = model.overview.person {
                        HStack(spacing: 10) {
                            if let color = Accent.color(person.color) {
                                Circle()
                                    .fill(color)
                                    .frame(width: 12, height: 12)
                            }
                            Text("\(person.name)'s")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Look.text)
                        }
                        .pageRow()
                    } else {
                        Text("Whose it is comes with the first device it pairs with.")
                            .foregroundStyle(Look.secondary)
                            .pageRow()
                    }
                } header: {
                    GroupLabel("This phone")
                        .textCase(nil)
                }
                Section {
                    ForEach(model.overview.devices, id: \.id) { device in
                        DeviceRow(device: device, now: context.date)
                            .pageRow()
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Unpair", role: .destructive) {
                                    unpairing = device
                                    confirming = true
                                }
                            }
                    }
                    Button("Pair another device", action: pairAnother)
                        .buttonStyle(.outlinedPill)
                        .listRowBackground(Look.background)
                        .listRowSeparator(.hidden)
                } header: {
                    GroupLabel("Devices")
                        .textCase(nil)
                }
                Section {
                    views
                } header: {
                    GroupLabel("Views")
                        .textCase(nil)
                }
            }
            .listStyle(.plain)
            .pageGround()
        }
        .refreshable { await ask() }
        .task(id: Asking(model.overview)) { await ask() }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Unpair this device?", isPresented: $confirming, titleVisibility: .visible, presenting: unpairing
        ) { device in
            Button("Unpair \(device.name)", role: .destructive) {
                model.act {
                    let told = try await model.phone.unpair(device: device.id)
                    model.pull()
                    if !told {
                        // It still lists this phone.
                        model.notice = "\(device.name) was not told: unpair this phone there too."
                    }
                }
            }
        } message: { device in
            Text("This phone forgets \(device.name), and \(device.name) forgets this phone.")
        }
    }

    /// A row for each view offered; while none is, whether that is known yet.
    @ViewBuilder
    private var views: some View {
        let rows = shelf.rows(workspaces: model.overview.workspaces, devices: model.overview.devices)
        if rows.isEmpty {
            if asked {
                Text("A community view that works on a phone, installed on your computer, shows here.")
                    .font(.footnote)
                    .foregroundStyle(Look.secondary)
                    .pageRow()
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .pageRow()
            }
        }
        ForEach(rows) { row in
            NavigationLink(value: row.view) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.view.info.name)
                        .foregroundStyle(Look.text)
                        .lineLimit(1)
                    Text(row.place)
                        .font(.footnote)
                        .foregroundStyle(Look.tertiary)
                        .lineLimit(1)
                }
                .padding(.vertical, 2)
            }
            .disabled(row.away)
            .opacity(row.away ? 0.5 : 1)
            .pageRow()
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

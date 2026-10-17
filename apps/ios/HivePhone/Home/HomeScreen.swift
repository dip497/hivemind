import SwiftUI

/// Where Home leads besides an agent.
enum HomePage: Hashable {
    case settings
}

/// Home, the app (design §6.2, §6.3): a device away, and what it last said; what waits on the
/// person, the longest-waiting first, each a card with the answers its wait allows; then every
/// agent, live, by device and workspace, with its state, its name and for how long. A long press
/// stops or closes one. The gear opens Settings; + starts an agent.
@MainActor
struct HomeScreen: View {
    let model: PhoneModel
    @State private var path = NavigationPath()
    @State private var composing: Composing? = nil
    @State private var starting = false
    @State private var pairingAnother = false

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.everyMinute) { context in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        needs(now: context.date)
                        agents(now: context.date)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
                .background(Look.background)
            }
            .navigationTitle("Home")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { starting = true } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Start an agent")
                    .disabled(model.overview.devices.isEmpty)
                    Button { path.append(HomePage.settings) } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("home.settings")
                }
            }
            .navigationDestination(for: AgentRef.self) { ref in
                AgentScreen(model: model, ref: ref)
            }
            .navigationDestination(for: HomePage.self) { page in
                switch page {
                case .settings:
                    SettingsScreen(model: model) { pairingAnother = true }
                }
            }
            .navigationDestination(for: OfferedView.self) { offered in
                ViewScreen(model: model, offered: offered)
            }
            .sheet(item: $composing) { item in
                AnswerSheet(model: model, agent: item.agent, waiting: item.waiting)
            }
            .sheet(isPresented: $starting) {
                StartView(model: model) { ref in
                    starting = false
                    path.append(ref)
                }
            }
        }
        .overlay(alignment: .top) { NoticeBanner(model: model) }
        .sheet(isPresented: $pairingAnother) {
            NavigationStack {
                PairView(model: model) { pairingAnother = false }
            }
        }
        .onChange(of: model.pendingLink, initial: true) { _, link in
            if link != nil { pairingAnother = true }
        }
    }

    /// The devices away or still asked, and what waits on the person.
    @ViewBuilder
    private func needs(now: Date) -> some View {
        ForEach(NeedsSummary.away(model.overview.devices), id: \.id) { device in
            Label(NeedsSummary.awayLine(device, now: now), systemImage: "wifi.slash")
                .font(.footnote)
                .foregroundStyle(Look.tertiary)
        }
        let asking = NeedsSummary.asking(model.overview.devices)
        ForEach(asking, id: \.id) { device in
            Label(NeedsSummary.askingLine(device), systemImage: "ellipsis")
                .font(.footnote)
                .foregroundStyle(Look.tertiary)
        }
        if model.overview.needs.isEmpty,
           let nothing = NeedsSummary.nothing(working: model.overview.working, asking: asking) {
            Text(nothing)
                .font(.subheadline)
                .foregroundStyle(Look.secondary)
        }
        ForEach(model.overview.needs, id: \.at) { agent in
            NeedRow(model: model, agent: agent, now: now) { waiting in
                composing = Composing(agent: agent, waiting: waiting)
            }
        }
    }

    /// Every agent, under its device and workspace.
    @ViewBuilder
    private func agents(now: Date) -> some View {
        if model.overview.agents.isEmpty {
            VStack(spacing: 6) {
                Text("No agents")
                    .font(.headline)
                    .foregroundStyle(Look.text)
                Text("Start one on one of your computers with +.")
                    .font(.subheadline)
                    .foregroundStyle(Look.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
        }
        ForEach(AgentSection.of(model.overview.agents)) { section in
            VStack(alignment: .leading, spacing: 0) {
                GroupLabel(section.title)
                    .padding(.top, 12)
                    .padding(.bottom, 4)
                ForEach(section.agents, id: \.at) { agent in
                    NavigationLink(value: agent.at) {
                        AgentRow(agent: agent, now: now)
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        if AgentLook.offersStop(agent) {
                            Button {
                                model.act { _ = try await model.phone.interrupt(agent: agent.at) }
                            } label: {
                                Label("Stop", systemImage: "stop.fill")
                            }
                        }
                        Button(role: .destructive) {
                            Task { _ = await model.close(agent.at, named: agent.name) }
                        } label: {
                            Label("Close", systemImage: "xmark")
                        }
                    }
                    if agent.at != section.agents.last?.at {
                        Rectangle()
                            .fill(Look.hairline)
                            .frame(height: 1)
                    }
                }
            }
        }
    }
}

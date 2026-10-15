import SwiftUI

/// Where Home leads besides an agent.
enum HomePage: Hashable {
    case settings
}

/// Home, the app (design §6.2, §6.3), listed as the desktop's Layers panel lists the board: a
/// search, and with more than one machine a chip for each; a device away, and what it last said;
/// what waits on the person, the longest-waiting first, each a card with the answers its wait
/// allows; then on each computer what is at work, what is pinned, and its projects, frames and
/// tiles, folded as the person left them and shown as the View menu says. A long press stops or
/// closes an agent. The gear opens Settings; + starts an agent.
@MainActor
struct HomeScreen: View {
    let model: PhoneModel
    @State private var path = NavigationPath()
    @State private var composing: Composing? = nil
    @State private var starting = false
    @State private var pairingAnother = false
    @State private var choices = HomeViewChoices.load()
    @State private var choosingView = false
    @State private var query = ""
    @State private var machine: String? = nil

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.everyMinute) { context in
                let shown = homes()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        machineChips(shown)
                        needs(now: context.date)
                        lists(shown, now: context.date)
                        elsewhere(shown, now: context.date)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
                .background(Look.background)
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
            .navigationTitle("Home")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { choosingView = true } label: {
                        Image(systemName: "slider.horizontal.3")
                            .overlay(alignment: .topTrailing) {
                                if !choices.isDefault {
                                    Circle()
                                        .fill(Look.waiting)
                                        .frame(width: 7, height: 7)
                                        .offset(x: 4, y: -3)
                                }
                            }
                    }
                    .accessibilityLabel("View")
                    .accessibilityValue(choices.isDefault ? "" : "Changed")
                    .accessibilityIdentifier("home.view")
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
                // Seen on opening and again on leaving: what it did while shown is not unread.
                AgentScreen(model: model, ref: ref)
                    .onAppear { see(ref) }
                    .onDisappear { see(ref) }
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
            .sheet(isPresented: $choosingView) {
                ViewChoicesSheet(choices: $choices)
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
        .onChange(of: choices) { _, kept in kept.save() }
    }

    /// Home on each computer the phone reached, asked again with each new overview.
    private func homes() -> [HomeShown] {
        _ = model.overview.revision
        return model.phone.home(query: query, machine: machine, choices: choices.choices())
    }

    /// The person opened `ref`'s tile: it is no longer unread.
    private func see(_ ref: AgentRef) {
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        for home in homes() where home.device == ref.device {
            for entry in home.working + home.pinned + home.tree {
                if case .tile(let key, _, let tile) = entry, tile.at == ref {
                    choices.saw(key, at: now)
                    return
                }
            }
        }
    }

    /// All, and a chip for each machine when there is more than one; the chosen one, chosen again,
    /// shows every machine.
    @ViewBuilder
    private func machineChips(_ shown: [HomeShown]) -> some View {
        let machines = shown.flatMap(\.machines).reduce(into: [String]()) { list, name in
            if !list.contains(name) { list.append(name) }
        }
        if !machines.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    Chip(label: "All", selected: machine == nil) { machine = nil }
                    ForEach(machines, id: \.self) { name in
                        Chip(label: name, selected: machine == name) {
                            machine = machine == name ? nil : name
                        }
                    }
                }
            }
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

    /// What is at work, what is pinned, then each computer's tree.
    @ViewBuilder
    private func lists(_ shown: [HomeShown], now: Date) -> some View {
        let working = Listed.of("working", shown) { $0.working }
        let pinned = Listed.of("pinned", shown) { $0.pinned }
        VStack(alignment: .leading, spacing: 0) {
            if !working.isEmpty {
                GroupLabel("Working")
                    .padding(.top, 12)
                    .padding(.bottom, 2)
                ForEach(working) { listed in entry(listed, now: now) }
            }
            if !pinned.isEmpty {
                GroupLabel("Pinned")
                    .padding(.top, 16)
                    .padding(.bottom, 2)
                ForEach(pinned) { listed in entry(listed, now: now) }
            }
            ForEach(shown.filter { !$0.tree.isEmpty }, id: \.device) { home in
                GroupLabel(home.computer)
                    .padding(.top, 16)
                    .padding(.bottom, 2)
                ForEach(Listed.of("tree", [home]) { $0.tree }) { listed in entry(listed, now: now) }
            }
        }
        if shown.allSatisfy({ $0.tree.isEmpty && $0.pinned.isEmpty }) && elsewhereAgents(shown).isEmpty {
            nothing
        }
    }

    /// Nothing to list: nothing matches what the person asked for, or nothing is open yet.
    @ViewBuilder
    private var nothing: some View {
        let asked = !query.isEmpty || machine != nil || !choices.isDefault
        VStack(spacing: 6) {
            Text(asked ? "Nothing matches." : "No agents")
                .font(.headline)
                .foregroundStyle(Look.text)
            if !asked {
                Text("Start one on one of your computers with +.")
                    .font(.subheadline)
                    .foregroundStyle(Look.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
    }

    /// One line of a list, as its kind draws it.
    @ViewBuilder
    private func entry(_ listed: Listed, now: Date) -> some View {
        switch listed.entry {
        case .machine(_, let name):
            Text(name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Look.text)
                .padding(.top, 12)
                .padding(.bottom, 2)
        case .project(let key, let name, _, _, let count, let state, let folded):
            HomeProjectRow(
                name: name, count: count, state: state, folded: folded,
                fold: { fold(key) }, start: { starting = true })
        case .frame(let key, let depth, let title, let color, let folder, let worktree, _, let count, let state, let folded):
            HomeFrameRow(
                depth: Int(depth), title: title, color: color, folder: folder, worktree: worktree,
                count: count, state: state, folded: folded) { fold(key) }
        case .section(let key, let label, let count, let state, let folded):
            if !label.isEmpty {
                HomeSectionRow(label: label, count: count, state: state, folded: folded) { fold(key) }
            }
        case .tile(_, let depth, let tile):
            tileRow(tile, depth: Int(depth), mark: tile.runs.flatMap { listed.marks[$0] }, now: now)
        }
    }

    private func fold(_ key: String) {
        withAnimation(.easeOut(duration: 0.15)) { choices.fold(key) }
    }

    /// A tile's row; an agent's or a terminal's opens it, and an agent's long press stops or
    /// closes it.
    @ViewBuilder
    private func tileRow(_ tile: HomeTile, depth: Int, mark: AgentMark?, now: Date) -> some View {
        let row = HomeTileRow(tile: tile, depth: depth, mark: mark, now: now)
        if let agent = model.overview.agents.first(where: { $0.at == tile.at }) {
            NavigationLink(value: tile.at) { row }
                .buttonStyle(.plain)
                .contextMenu { actions(agent) }
        } else if tile.terminal {
            NavigationLink(value: tile.at) { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }

    @ViewBuilder
    private func actions(_ agent: Agent) -> some View {
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

    /// The agents of a device whose Home has not come yet, as the overview lists them.
    private func elsewhereAgents(_ shown: [HomeShown]) -> [Agent] {
        let homed = Set(shown.map(\.device))
        return model.overview.agents.filter { !homed.contains($0.at.device) }
    }

    /// Those agents under their device and workspace.
    @ViewBuilder
    private func elsewhere(_ shown: [HomeShown], now: Date) -> some View {
        ForEach(AgentSection.of(elsewhereAgents(shown))) { section in
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
                    .contextMenu { actions(agent) }
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

/// A line of one of Home's lists, named by the list, the computer and its key: a tile can be in
/// more than one list.
private struct Listed: Identifiable {
    let id: String
    let entry: HomeEntry
    /// The marks of the computer it is on.
    let marks: [String: AgentMark]

    static func of(_ list: String, _ homes: [HomeShown], _ entries: (HomeShown) -> [HomeEntry]) -> [Listed] {
        homes.flatMap { home in
            entries(home).map { Listed(id: "\(list)/\(home.device)/\($0.key)", entry: $0, marks: home.marks) }
        }
    }
}

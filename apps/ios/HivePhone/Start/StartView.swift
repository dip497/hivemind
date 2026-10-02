import SwiftUI

/// Starting an agent (design §6.6): device → workspace → folder → agent, with its model and mode
/// when it has them → prompt → Start, once the phone's own lock says it is the person; then the new
/// agent's screen.
@MainActor
struct StartView: View {
    let model: PhoneModel
    let started: (AgentRef) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var device: String? = nil
    @State private var workspace: String? = nil
    @State private var startable: Startable? = nil
    @State private var frame: String? = nil
    @State private var program: String? = nil
    @State private var modelChoice: String? = nil
    @State private var modeChoice: String? = nil
    @State private var modelText = ""
    @State private var modeText = ""
    @State private var prompt = ""
    @State private var busy = false
    @State private var failure: String? = nil

    var body: some View {
        NavigationStack {
            Form {
                Section("Device") {
                    Picker("Device", selection: $device) {
                        Text("Choose").tag(String?.none)
                        ForEach(model.overview.devices, id: \.id) { device in
                            Text(device.reachable ? device.name : "\(device.name) (away)")
                                .tag(Optional(device.id))
                        }
                    }
                }
                if let device {
                    Section("Workspace") {
                        Picker("Workspace", selection: $workspace) {
                            Text("Choose").tag(String?.none)
                            ForEach(StartChoices.workspaces(on: device, in: model.overview.agents)) { workspace in
                                Text(workspace.name).tag(Optional(workspace.id))
                            }
                        }
                    }
                }
                if let startable {
                    Section("Folder") {
                        Picker("Folder", selection: $frame) {
                            Text("The workspace's own").tag(String?.none)
                            ForEach(startable.frames, id: \.id) { frame in
                                Text("\(frame.name) · \(frame.machine)").tag(Optional(frame.id))
                            }
                        }
                    }
                    Section("Agent") {
                        Picker("Agent", selection: $program) {
                            ForEach(startable.programs, id: \.id) { program in
                                Text(program.label).tag(Optional(program.id))
                            }
                        }
                        if let chosen = startable.programs.first(where: { $0.id == program }) {
                            ForEach(chosen.options, id: \.id) { option in
                                optionField(option)
                            }
                        }
                    }
                    Section("Prompt") {
                        TextField("What it should do (optional)", text: $prompt, axis: .vertical)
                            .lineLimit(3...8)
                    }
                }
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Start an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start", action: start)
                        .disabled(busy || device == nil || workspace == nil || program == nil)
                }
            }
            .onChange(of: device) { _, _ in
                workspace = nil
            }
            .onChange(of: program) { _, _ in
                modelChoice = nil
                modeChoice = nil
                modelText = ""
                modeText = ""
            }
            .task(id: "\(device ?? "")\n\(workspace ?? "")") { await load() }
        }
    }

    /// A model or a mode: one of the values the agent offers, or free text when it lists none.
    @ViewBuilder
    private func optionField(_ option: StartOption) -> some View {
        switch option.id {
        case "model": choice(option, selection: $modelChoice, text: $modelText)
        case "mode": choice(option, selection: $modeChoice, text: $modeText)
        default: EmptyView()
        }
    }

    @ViewBuilder
    private func choice(_ option: StartOption, selection: Binding<String?>, text: Binding<String>) -> some View {
        if option.values.isEmpty {
            TextField(option.label, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } else {
            Picker(option.label, selection: selection) {
                Text("Its default").tag(String?.none)
                ForEach(option.values, id: \.self) { value in
                    Text(value).tag(Optional(value))
                }
            }
        }
    }

    /// What the chosen workspace's host can start, and where.
    private func load() async {
        startable = nil
        frame = nil
        program = nil
        guard let device, let workspace else { return }
        failure = nil
        do {
            let found = try await model.phone.startable(device: device, workspace: workspace)
            // A choice changed while the device answered: its own load is under way.
            guard !Task.isCancelled else { return }
            startable = found
            program = found.programs.first?.id
        } catch {
            guard !Task.isCancelled else { return }
            failure = ErrorText.of(error)
        }
    }

    private func start() {
        guard let device, let workspace, let program else { return }
        let label = startable?.programs.first(where: { $0.id == program })?.label ?? program
        let deviceName = model.overview.devices.first(where: { $0.id == device })?.name ?? device
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let request = Start(
            program: program,
            frame: frame,
            prompt: text.isEmpty ? nil : text,
            model: modelChoice ?? (modelText.isEmpty ? nil : modelText),
            mode: modeChoice ?? (modeText.isEmpty ? nil : modeText))
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            switch await DeviceLock.ask("Start \(label) on \(deviceName)") {
            case .unlocked:
                break
            case .cancelled:
                return
            case .unavailable(let reason):
                failure = reason
                return
            }
            do {
                let agent = try await model.phone.start(device: device, workspace: workspace, start: request)
                started(agent)
            } catch {
                failure = ErrorText.of(error)
            }
        }
    }
}

/// The workspaces an agent can be started in on a device: those the overview shows an agent of.
enum StartChoices {
    struct Workspace: Identifiable, Hashable {
        let id: String
        let name: String
    }

    static func workspaces(on device: String, in agents: [Agent]) -> [Workspace] {
        var seen = Set<String>()
        var found: [Workspace] = []
        for agent in agents where agent.at.device == device && seen.insert(agent.at.workspace).inserted {
            found.append(Workspace(id: agent.at.workspace, name: agent.workspaceName))
        }
        return found
    }
}

import SwiftUI

/// Starting an agent (design §6.6): device → workspace → folder → agent, with its model and mode
/// when it has them, as rows of chips → the prompt in a raised card → Start, once the phone's own
/// lock says it is the person; then the new agent's screen.
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
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    GroupLabel("Device")
                    chips {
                        ForEach(model.overview.devices, id: \.id) { choice in
                            Chip(label: choice.name, selected: device == choice.id, reached: choice.reachable) {
                                device = choice.id
                            }
                        }
                    }
                    if let device {
                        GroupLabel("Workspace")
                            .padding(.top, 6)
                        chips {
                            ForEach(workspaces(on: device), id: \.id) { choice in
                                Chip(label: choice.name, selected: workspace == choice.id) { workspace = choice.id }
                            }
                        }
                        if let folder = workspaces(on: device).first(where: { $0.id == workspace })?.folder {
                            Text(folder)
                                .font(.footnote.monospaced())
                                .foregroundStyle(Look.tertiary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                    if let startable {
                        GroupLabel("Folder")
                            .padding(.top, 6)
                        chips {
                            Chip(label: "The workspace's own", selected: frame == nil) { frame = nil }
                            ForEach(startable.frames, id: \.id) { choice in
                                Chip(label: "\(choice.name) · \(choice.machine)", selected: frame == choice.id) {
                                    frame = choice.id
                                }
                            }
                        }
                        GroupLabel("Agent")
                            .padding(.top, 6)
                        chips {
                            ForEach(startable.programs, id: \.id) { choice in
                                Chip(label: choice.label, selected: program == choice.id) { program = choice.id }
                            }
                        }
                        if let chosen = startable.programs.first(where: { $0.id == program }) {
                            ForEach(chosen.options, id: \.id) { option in
                                optionField(option)
                            }
                        }
                        promptCard
                            .padding(.top, 8)
                    }
                    if let failure {
                        Text(failure)
                            .font(.subheadline)
                            .foregroundStyle(Look.failed)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(Look.background)
            .navigationTitle("Start an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
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

    /// A row of chips, scrolled across when they do not fit.
    private func chips<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                content()
            }
        }
    }

    /// What it should do, in a raised card, with a round Start.
    private var promptCard: some View {
        let ready = !busy && device != nil && workspace != nil && program != nil
        return VStack(alignment: .trailing, spacing: 8) {
            TextField("What should it do? (optional)", text: $prompt, axis: .vertical)
                .lineLimit(4...10)
                .textFieldStyle(.plain)
                .foregroundStyle(Look.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: start) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Look.onPrimary)
                    .frame(width: 36, height: 36)
                    .background(Look.text.opacity(ready ? 1 : 0.25), in: Circle())
            }
            .accessibilityLabel("Start")
            .disabled(!ready)
        }
        .padding(14)
        .raisedCard()
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
        GroupLabel(option.label)
            .padding(.top, 6)
        if option.values.isEmpty {
            TextField(option.label, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .frame(height: 36)
                .overlay { Capsule().strokeBorder(Look.outline, lineWidth: 1) }
        } else {
            chips {
                Chip(label: "Its default", selected: selection.wrappedValue == nil) { selection.wrappedValue = nil }
                ForEach(option.values, id: \.self) { value in
                    Chip(label: value, selected: selection.wrappedValue == value) { selection.wrappedValue = value }
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

    /// The workspaces `device` holds, as the overview has them.
    private func workspaces(on device: String) -> [Workspace] {
        model.overview.workspaces.filter { $0.device == device }
    }
}

import SwiftUI

/// Pairing (design §6.1): the camera reads the QR code the computer shows, or its link is pasted;
/// then whose the phone is now, in their name and colour. A link to connect (spec/pairing.md 0.10)
/// only asks: the words both screens show, the computer's answer, and the person's own yes before
/// the phone is theirs. The core checks the link; what it says of one it refuses is shown as it
/// says it.
@MainActor
struct PairView: View {
    let model: PhoneModel
    /// Pairing is over: the person has read whose the phone is.
    let done: () -> Void

    @State private var link = ""
    @State private var scanning = false
    @State private var busy = false
    /// What runs now, naming the computer as the core reads the link.
    @State private var progress = "Pairing…"
    @State private var failure: String? = nil
    @State private var paired: Paired? = nil
    /// The offer asked with, while the person at the computer decides and then the person here.
    @State private var connecting: Connecting? = nil
    /// The computer said the phone is its person's: whose, as it says (nil before it said).
    @State private var told: Person?? = nil

    var body: some View {
        ScrollView {
            Group {
                if let paired {
                    PairedCard(paired: paired, done: done)
                } else if let connecting {
                    ConnectingCard(connecting: connecting, told: told, busy: busy, answer: answer)
                } else {
                    form
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .background(Look.background)
        .navigationTitle("Pair with hivemind")
        .task(id: model.pendingLink) { takePendingLink() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("On your computer, open Settings → Connect, and scan the code it shows.")
                .foregroundStyle(Look.secondary)
            if scanning {
                QRScanner { code in
                    scanning = false
                    pair(code)
                }
                .frame(height: 320)
                .clipShape(RoundedRectangle(cornerRadius: Look.cardRadius, style: .continuous))
            } else {
                Button {
                    scanning = true
                } label: {
                    Label("Scan the code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.filledPill)
                .disabled(busy)
            }
            Text("Or paste the link it shows")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Look.text)
            HStack(spacing: 10) {
                TextField("hivemind://connect/…", text: $link)
                    .textFieldStyle(.plain)
                    .font(.callout.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { pair(link) }
                    .accessibilityIdentifier("pair.link")
                    .padding(.horizontal, 14)
                    .frame(height: 40)
                    .overlay { Capsule().strokeBorder(Look.outline, lineWidth: 1) }
                PasteButton(payloadType: String.self) { strings in
                    guard let pasted = strings.first else { return }
                    link = pasted
                    pair(pasted)
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.capsule)
                // The system draws its label white: a dark ground in both looks keeps it readable.
                .tint(Color(uiColor: Tones.tone(0x171717, 0x3d3d3d)))
            }
            Button("Pair") { pair(link) }
                .buttonStyle(.outlinedPill)
                .disabled(busy || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if busy {
                ProgressView(progress)
            }
            if let failure {
                Text(failure)
                    .foregroundStyle(Look.failed)
                    .accessibilityIdentifier("pair.error")
            }
        }
    }

    private func pair(_ text: String) {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty, !busy else { return }
        if let computer = connectsWith(link: link) { return connect(link, to: computer.name) }
        busy = true
        failure = nil
        progress = pairsWith(link: link).map { "Pairing with \($0.name)…" } ?? "Pairing…"
        Task { @MainActor in
            do {
                paired = try await model.phone.pair(link: link)
                model.pull()
            } catch {
                failure = ErrorText.of(error)
            }
            busy = false
        }
    }

    /// Ask with an offer to connect, and wait on the person at the computer.
    private func connect(_ link: String, to computer: String) {
        busy = true
        failure = nil
        progress = "Connecting to \(computer)…"
        Task { @MainActor in
            do {
                let asked = try await model.phone.connect(link: link)
                connecting = asked
                busy = false
                let whose = try await asked.wait()
                told = .some(whose)
            } catch {
                failure = ErrorText.of(error)
                connecting = nil
            }
            busy = false
        }
    }

    /// The person here says whether the words match: the phone takes what the computer gives on
    /// yes, and tells it no otherwise.
    private func answer(_ match: Bool) {
        guard let asked = connecting, !busy else { return }
        busy = true
        Task { @MainActor in
            do {
                if match {
                    paired = try await asked.take()
                    model.pull()
                } else {
                    try await asked.refuse()
                    failure = "Nothing was taken: the words did not match."
                }
            } catch {
                failure = ErrorText.of(error)
            }
            connecting = nil
            told = nil
            busy = false
        }
    }

    /// A link the system opened the app with pairs as one pasted here.
    private func takePendingLink() {
        guard let pending = model.pendingLink else { return }
        model.pendingLink = nil
        link = pending
        pair(pending)
    }
}

/// An offer asked with: the words to check on the computer, waiting on the person there; then, once
/// it says the phone is its person's, the person here says whether the words match.
private struct ConnectingCard: View {
    let connecting: Connecting
    let told: Person??
    let busy: Bool
    let answer: (Bool) -> Void

    var body: some View {
        let computer = connecting.offering()
        VStack(alignment: .leading, spacing: 16) {
            Text("Check that \(computer) shows these words:")
                .foregroundStyle(Look.secondary)
            Text(connecting.words().joined(separator: " · "))
                .font(.largeTitle.weight(.semibold))
                .accessibilityIdentifier("connect.words")
            if let told {
                let whose = told?.name
                Text("\(computer) says this phone is \(whose.map { "\($0)'s" } ?? "its person's"). Do the words match?")
                    .accessibilityIdentifier("connect.told")
                Button(whose.map { "Yes, make this phone \($0)'s" } ?? "Yes, the words match") { answer(true) }
                    .buttonStyle(.filledPill)
                    .disabled(busy)
                    .accessibilityIdentifier("connect.yes")
                Button("No") { answer(false) }
                    .buttonStyle(.outlinedPill)
                    .disabled(busy)
                    .accessibilityIdentifier("connect.no")
            } else {
                ProgressView("Waiting for \(computer)…")
            }
        }
    }
}

/// Whose the phone is now: their name, in their colour.
private struct PairedCard: View {
    let paired: Paired
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Paired with \(paired.name)", systemImage: "checkmark.circle.fill")
                .font(.title3.weight(.semibold))
            if let person = paired.person {
                HStack(spacing: 10) {
                    if let color = Accent.color(person.color) {
                        Circle()
                            .fill(color)
                            .frame(width: 14, height: 14)
                    }
                    Text("This phone is \(person.name)'s.")
                }
            }
            Button("Continue", action: done)
                .buttonStyle(.filledPill)
        }
    }
}

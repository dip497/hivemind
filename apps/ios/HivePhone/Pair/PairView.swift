import SwiftUI

/// Pairing (design §6.1): the camera reads the QR code the computer shows, or its link is pasted;
/// then whose the phone is now, in their name and colour. The core checks the link; what it says
/// of one it refuses is shown as it says it.
@MainActor
struct PairView: View {
    let model: PhoneModel
    /// Pairing is over: the person has read whose the phone is.
    let done: () -> Void

    @State private var link = ""
    @State private var scanning = false
    @State private var busy = false
    /// The computer being paired with, by name, as the core reads the link.
    @State private var pairingWith: String? = nil
    @State private var failure: String? = nil
    @State private var paired: Paired? = nil

    var body: some View {
        ScrollView {
            Group {
                if let paired {
                    PairedCard(paired: paired, done: done)
                } else {
                    form
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .navigationTitle("Pair with hivemind")
        .task(id: model.pendingLink) { takePendingLink() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("On your computer, open Settings → Devices → Pair a phone, and scan the code it shows.")
                .foregroundStyle(.secondary)
            if scanning {
                QRScanner { code in
                    scanning = false
                    pair(code)
                }
                .frame(height: 320)
                .clipShape(RoundedRectangle(cornerRadius: 16))
            } else {
                Button {
                    scanning = true
                } label: {
                    Label("Scan the code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(busy)
            }
            Text("Or paste the link it shows")
                .font(.subheadline.weight(.semibold))
            HStack(spacing: 10) {
                TextField("hivemind://pair/…", text: $link)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { pair(link) }
                    .accessibilityIdentifier("pair.link")
                PasteButton(payloadType: String.self) { strings in
                    guard let pasted = strings.first else { return }
                    link = pasted
                    pair(pasted)
                }
                .labelStyle(.iconOnly)
            }
            Button("Pair") { pair(link) }
                .buttonStyle(.bordered)
                .disabled(busy || link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if busy {
                ProgressView(pairingWith.map { "Pairing with \($0)…" } ?? "Pairing…")
            }
            if let failure {
                Text(failure)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("pair.error")
            }
        }
    }

    private func pair(_ text: String) {
        let link = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty, !busy else { return }
        busy = true
        failure = nil
        pairingWith = pairsWith(link: link)?.name
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

    /// A link the system opened the app with pairs as one pasted here.
    private func takePendingLink() {
        guard let pending = model.pendingLink else { return }
        model.pendingLink = nil
        link = pending
        pair(pending)
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
                    Circle()
                        .fill(Accent.color(person.color) ?? Color.accentColor)
                        .frame(width: 14, height: 14)
                    Text("This phone is \(person.name)'s.")
                }
            }
            Button("Continue", action: done)
                .buttonStyle(.borderedProminent)
        }
    }
}

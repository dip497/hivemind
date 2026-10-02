import SwiftUI

/// Whose the phone is, each of the person's devices it is paired with, reachable or away; unpairing
/// one, and pairing another (design §6.7).
@MainActor
struct DevicesTab: View {
    let model: PhoneModel
    let pairAnother: () -> Void
    @State private var unpairing: Device? = nil
    @State private var confirming = false

    var body: some View {
        NavigationStack {
            TimelineView(.everyMinute) { context in
                List {
                    Section("This phone") {
                        if let person = model.overview.person {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(Accent.color(person.color) ?? Color.accentColor)
                                    .frame(width: 12, height: 12)
                                Text("\(person.name)'s")
                            }
                        } else {
                            Text("Whose it is comes with the first device it pairs with.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Devices") {
                        ForEach(model.overview.devices, id: \.id) { device in
                            DeviceRow(device: device, now: context.date)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button("Unpair", role: .destructive) {
                                        unpairing = device
                                        confirming = true
                                    }
                                }
                        }
                    }
                    Section {
                        Button("Pair another device", action: pairAnother)
                    }
                }
            }
            .navigationTitle("Devices")
            .confirmationDialog(
                "Unpair this device?", isPresented: $confirming, titleVisibility: .visible, presenting: unpairing
            ) { device in
                Button("Unpair \(device.name)", role: .destructive) {
                    model.act {
                        _ = try await model.phone.unpair(device: device.id)
                        model.pull()
                    }
                }
            } message: { device in
                Text("This phone forgets \(device.name), and \(device.name) forgets this phone.")
            }
        }
    }
}

/// A device: its name, what it is, and whether the phone reaches it now.
struct DeviceRow: View {
    let device: Device
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(device.reachable ? Color.green : Color.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                Text(state)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var icon: String {
        switch device.kind {
        case .computer: return "laptopcomputer"
        case .host: return "server.rack"
        }
    }

    private var state: String {
        if device.reachable { return "connected" }
        if device.awaySince != nil {
            guard let heard = device.heardAt else { return "away" }
            return "away · last heard \(Ago.span(since: heard, now: now)) ago"
        }
        return "connecting…"
    }
}

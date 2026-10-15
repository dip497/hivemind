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
                    } header: {
                        GroupLabel("Devices")
                            .textCase(nil)
                    }
                    Section {
                        Button("Pair another device", action: pairAnother)
                            .buttonStyle(.outlinedPill)
                            .listRowBackground(Look.background)
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
                .pageGround()
            }
            .navigationTitle("Devices")
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
    }
}

/// A device: a dot, filled while the phone reaches it and hollow when not; its name, whether the
/// phone reaches it now or when it was last heard, and what it is.
struct DeviceRow: View {
    let device: Device
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            Dot(color: device.reachable ? Look.done : Look.tertiary, filled: device.reachable)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.name)
                    .foregroundStyle(Look.text)
                    .lineLimit(1)
                Text(state)
                    .font(.footnote)
                    .foregroundStyle(Look.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: icon)
                .foregroundStyle(Look.tertiary)
        }
        .padding(.vertical, 2)
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

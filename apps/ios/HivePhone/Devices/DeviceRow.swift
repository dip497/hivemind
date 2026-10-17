import SwiftUI

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

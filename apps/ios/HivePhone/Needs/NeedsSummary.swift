import Foundation

/// The words of the Needs tab (design §6.2), from the overview's records.
enum NeedsSummary {
    /// When nothing waits: how many agents are at work. Nothing, while a device is still asked:
    /// until each has said, that nothing waits is not known.
    static func nothing(working: UInt32, asking: [Device]) -> String? {
        guard asking.isEmpty else { return nil }
        switch working {
        case 0: return "Nothing needs you."
        case 1: return "Nothing needs you. 1 agent working."
        default: return "Nothing needs you. \(working) agents working."
        }
    }

    /// The devices not found away that have not said yet what waits there.
    static func asking(_ devices: [Device]) -> [Device] {
        devices.filter { $0.answeredAt == nil && $0.awaySince == nil }
    }

    /// "Asking desk…"
    static func askingLine(_ device: Device) -> String {
        "Asking \(device.name)…"
    }

    /// The devices the core found away. Not merely not connected: every device is that for a
    /// moment after the app comes back, before the core has dialled it.
    static func away(_ devices: [Device]) -> [Device] {
        devices.filter { !$0.reachable && $0.awaySince != nil }
    }

    /// "desk is away · last heard 5 min ago"
    static func awayLine(_ device: Device, now: Date) -> String {
        guard let heard = device.heardAt else { return "\(device.name) is away" }
        return "\(device.name) is away · last heard \(Ago.span(since: heard, now: now)) ago"
    }

    /// Why an agent waits, said as its row and its banner say it.
    static func why(_ kind: WaitKind) -> String {
        switch kind {
        case .permission: return "Asks for a permission"
        case .question: return "Asks a question"
        case .plan: return "Has a plan for you to approve"
        case .other: return "Waits on you"
        }
    }
}

/// What the person can answer a wait with (design §6.2): Allow and Deny for a permission the device
/// can decide, a plan to approve or send back, a reply to a question; anything else is answered in
/// the agent's terminal.
enum Answers: Equatable {
    case decide
    case plan
    case reply
    case terminal

    init(_ waiting: Waiting) {
        switch waiting.kind {
        case .permission: self = waiting.decide ? .decide : .terminal
        case .plan: self = .plan
        case .question: self = .reply
        case .other: self = .terminal
        }
    }
}

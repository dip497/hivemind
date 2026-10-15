import Foundation

/// The words of what needs the person on Home (design §6.2), from the overview's records.
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

    /// What an agent waiting on the person asks for, as the card over its answers names it.
    static func asked(_ kind: WaitKind) -> String {
        switch kind {
        case .permission: return "Permission requested"
        case .question: return "Question"
        case .plan: return "Plan to approve"
        case .other: return "Waiting on you"
        }
    }
}

/// What the person can answer a wait with (design §6.2): Allow and Deny for a permission the device
/// can decide, a plan to approve or send back, an option of a question's one question, several
/// questions each answered, a reply to a question; anything else is answered in the agent's
/// terminal.
enum Answers: Equatable {
    case decide
    case plan
    case choose
    case questions
    case reply
    case terminal

    init(_ waiting: Waiting) {
        switch waiting.kind {
        case .permission: self = waiting.decide ? .decide : .terminal
        case .plan: self = .plan
        case .question:
            let questions = waiting.questions
            if !waiting.choose || questions.isEmpty {
                self = .reply
            } else if questions.count == 1 && !questions[0].many {
                self = .choose
            } else {
                self = .questions
            }
        case .other: self = .terminal
        }
    }
}

/// The person's answers to a wait's questions as they choose them: for each, the options chosen
/// (one, unless it says several may be), or a line of their own, which wins while it has text.
struct QuestionPicks: Equatable {
    let questions: [Question]
    private(set) var chosen: [Set<Int>]
    var own: [String]

    init(_ questions: [Question]) {
        self.questions = questions
        chosen = questions.map { _ in [] }
        own = questions.map { _ in "" }
    }

    /// Option `option` of question `question`, chosen, or no longer when it was.
    mutating func pick(_ option: Int, of question: Int) {
        guard questions.indices.contains(question) else { return }
        if chosen[question].contains(option) {
            chosen[question].remove(option)
        } else {
            if !questions[question].many { chosen[question].removeAll() }
            chosen[question].insert(option)
        }
        own[question] = ""
    }

    func isChosen(_ option: Int, of question: Int) -> Bool {
        questions.indices.contains(question) && typed(question).isEmpty && chosen[question].contains(option)
    }

    /// Each question has an answer.
    var answered: Bool {
        questions.indices.allSatisfy { !typed($0).isEmpty || !chosen[$0].isEmpty }
    }

    /// The answers, each in its question's place.
    var answers: [QuestionAnswer] {
        questions.indices.map { question in
            let line = typed(question)
            return line.isEmpty
                ? .chosen(options: chosen[question].sorted().map { UInt32($0) })
                : .text(text: line)
        }
    }

    private func typed(_ question: Int) -> String {
        own[question].trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

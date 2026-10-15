import Foundation

/// What the person chose to see on Home, kept phone-wide in one record: the View menu's choices,
/// the projects, frames and sections they folded (by key), and when they last opened each tile
/// (milliseconds, by key), which is what makes a tile unread. The core is given it on every call.
struct HomeViewChoices: Codable, Equatable {
    var status = "all"
    var activity = "all"
    var groupBy = "group"
    var sortBy = "canvas"
    var folded: [String] = []
    var seen: [String: UInt64] = [:]

    static let storageKey = "home.choices"
    /// The most tiles remembered as opened; the longest unopened are forgotten first.
    static let seenLimit = 500

    static func load() -> HomeViewChoices {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let kept = try? JSONDecoder().decode(HomeViewChoices.self, from: data)
        else { return HomeViewChoices() }
        return kept
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.storageKey)
        }
    }

    /// Every View choice is its default: the View button shows no dot.
    var isDefault: Bool {
        status == "all" && activity == "all" && groupBy == "group" && sortBy == "canvas"
    }

    /// The View choices back to their defaults; what is folded and seen stays.
    mutating func resetView() {
        let fresh = HomeViewChoices()
        status = fresh.status
        activity = fresh.activity
        groupBy = fresh.groupBy
        sortBy = fresh.sortBy
    }

    /// Folds what `key` names, or unfolds it when folded.
    mutating func fold(_ key: String) {
        if let index = folded.firstIndex(of: key) {
            folded.remove(at: index)
        } else {
            folded.append(key)
        }
    }

    /// The person opened the tile `key` names at `millis`.
    mutating func saw(_ key: String, at millis: UInt64) {
        seen[key] = millis
        if seen.count > Self.seenLimit {
            let oldest = seen.sorted { $0.value < $1.value }.prefix(seen.count - Self.seenLimit)
            for (old, _) in oldest { seen[old] = nil }
        }
    }

    /// As the core takes them, with how many minutes this phone's clock is ahead of UTC.
    func choices() -> HomeChoices {
        HomeChoices(
            status: status, activity: activity, groupBy: groupBy, sortBy: sortBy,
            folded: folded, seen: seen, offsetMinutes: Int32(TimeZone.current.secondsFromGMT() / 60))
    }
}

/// One of the View menu's choices: its id, as the core reads it, and its word.
struct ViewOption: Identifiable {
    let id: String
    let label: String
}

/// A group of the View menu, in the desktop's words.
struct ViewChoiceGroup: Identifiable {
    let title: String
    let choice: WritableKeyPath<HomeViewChoices, String>
    let options: [ViewOption]

    var id: String { title }

    static var all: [ViewChoiceGroup] {
        [
            ViewChoiceGroup(title: "Status", choice: \.status, options: [
                ViewOption(id: "all", label: "All"),
                ViewOption(id: "needs-you", label: "Needs you"),
                ViewOption(id: "unread", label: "Unread"),
                ViewOption(id: "working", label: "Working"),
                ViewOption(id: "idle", label: "Idle"),
                ViewOption(id: "exited", label: "Exited"),
            ]),
            ViewChoiceGroup(title: "Activity", choice: \.activity, options: [
                ViewOption(id: "all", label: "All"),
                ViewOption(id: "hour", label: "Past hour"),
                ViewOption(id: "today", label: "Today"),
                ViewOption(id: "week", label: "This week"),
            ]),
            ViewChoiceGroup(title: "Group by", choice: \.groupBy, options: [
                ViewOption(id: "group", label: "Project"),
                ViewOption(id: "machine", label: "Machine"),
                ViewOption(id: "date", label: "Date"),
                ViewOption(id: "status", label: "Status"),
                ViewOption(id: "agent", label: "Agent"),
                ViewOption(id: "none", label: "None"),
            ]),
            ViewChoiceGroup(title: "Sort by", choice: \.sortBy, options: [
                ViewOption(id: "canvas", label: "Canvas order"),
                ViewOption(id: "activity", label: "Last activity"),
                ViewOption(id: "name", label: "Name"),
            ]),
        ]
    }
}

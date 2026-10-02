import Foundation

/// A piece of what the agent said, as the chat draws it: its markdown text, or a code block, drawn
/// monospace.
enum MessagePart: Equatable {
    case text(AttributedString)
    case code(String)
}

/// One row of the chat: what one entry said, or a tool the agent used with what it gave back folded
/// under it.
struct ChatRow: Equatable {
    enum Said: Equatable {
        case person(String)
        case agent([MessagePart])
        case tool(Tool, result: ToolResult?)
        /// What a tool gave back, of a use told before what the chat shows.
        case result(ToolResult)
    }

    /// The entry's id.
    let id: String
    /// When, ms since the epoch.
    let at: UInt64
    var said: Said

    /// A tool's use with what it gave back, to unfold.
    var folds: Bool {
        if case .tool(_, let result) = said { return result != nil }
        return false
    }
}

/// The chat of one conversation (design §5.4, P7): its rows in the order said, each entry's once,
/// by its id, a tool's result folded under its use. It only grows, but when it is told anew (the
/// first telling, and each after the agent began another session): then what it tells replaces
/// all. Each telling says what changed, so that the chat inserts the rows that are new and draws
/// again the few that changed, and lays out nothing else.
struct ChatLog {
    struct Change: Equatable {
        /// What was shown before is gone: the chat shows the log afresh.
        var reset = false
        /// The rows added at the end.
        var appended: Range<Int> = 0..<0
        /// The rows shown before that changed: a tool's result folded under its use.
        var updated: [Int] = []
    }

    private(set) var rows: [ChatRow] = []
    /// Why it is told no more, once it is.
    private(set) var ended: ConversationEnded? = nil
    private var shown: Set<String> = []
    /// Each tool use's row, by the use's id.
    private var uses: [String: Int] = [:]

    mutating func take(_ entries: [Entry], anew: Bool) -> Change {
        var change = Change()
        if anew {
            rows.removeAll()
            shown.removeAll()
            uses.removeAll()
            ended = nil
            change.reset = true
        }
        let start = rows.count
        for entry in entries where shown.insert(entry.id).inserted {
            if case .toolOutput(let result) = entry.said, let row = uses[result.of], case .tool(let tool, nil) = rows[row].said {
                rows[row].said = .tool(tool, result: result)
                if row < start && !change.updated.contains(row) { change.updated.append(row) }
                continue
            }
            let said: ChatRow.Said
            switch entry.said {
            case .person(let text):
                said = .person(text)
            case .agent(let text):
                said = .agent(ChatMarkdown.parts(text))
            case .toolUse(let tool):
                uses[tool.id] = rows.count
                said = .tool(tool, result: nil)
            case .toolOutput(let result):
                said = .result(result)
            }
            rows.append(ChatRow(id: entry.id, at: entry.at, said: said))
        }
        change.appended = start..<rows.count
        return change
    }

    /// Told once, last: whether this is the first time.
    mutating func end(_ why: ConversationEnded) -> Bool {
        guard ended == nil else { return false }
        ended = why
        return true
    }

    /// Why a conversation is told no more, in words.
    static func words(_ ended: ConversationEnded) -> String {
        switch ended {
        case .refused(let why):
            return "Not followed any more: \(why)"
        case .notHeld:
            return "Not followed any more: its workspace is not on its device now."
        case .unpaired:
            return "Not followed any more: its device is not one of yours now."
        }
    }
}

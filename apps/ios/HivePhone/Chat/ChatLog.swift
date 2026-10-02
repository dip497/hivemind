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
    private(set) var ended: String? = nil
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
            if let result = entry.result, let row = uses[result.of], case .tool(let tool, nil) = rows[row].said {
                rows[row].said = .tool(tool, result: result)
                if row < start && !change.updated.contains(row) { change.updated.append(row) }
                continue
            }
            let said: ChatRow.Said
            switch entry.who {
            case .person:
                said = .person(entry.text ?? "")
            case .agent:
                if let tool = entry.tool {
                    uses[tool.id] = rows.count
                    said = .tool(tool, result: nil)
                } else {
                    said = .agent(ChatMarkdown.parts(entry.text ?? ""))
                }
            case .tool:
                guard let result = entry.result else { continue }
                said = .result(result)
            }
            rows.append(ChatRow(id: entry.id, at: entry.at, said: said))
        }
        change.appended = start..<rows.count
        return change
    }

    /// Told once, last: whether this is the first time.
    mutating func end(_ why: String) -> Bool {
        guard ended == nil else { return false }
        ended = why
        return true
    }
}

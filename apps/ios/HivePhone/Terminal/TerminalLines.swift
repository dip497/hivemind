import Foundation

/// A line as it is drawn: its text, indexed in UTF-16 as its runs are, and its runs, read once.
struct TerminalLine {
    let text: String
    let runs: [TerminalRun]

    init(_ line: ScreenLine) {
        text = line.text
        runs = PackedRuns.decode(line.runs)
    }
}

/// What one update changed: the lines to draw again, and whether the session's width did (then the
/// terminal fits the width again and draws every line).
struct TerminalChanges: Equatable {
    var lines: [UInt64] = []
    var resized = false
}

/// The lines of one watch the app holds, by index (design §5.3: a line's number since the watch
/// began, so it names the same line as it scrolls into history), and the session around them.
/// The app may hold lines the core has let go of (it keeps 2,000): the terminal keeps what the
/// person scrolled up to read until they come back to the newest.
struct TerminalLines {
    struct Cursor: Equatable {
        var line: UInt64
        var col: Int
    }

    /// The revision last taken: the next pull asks for what changed since.
    private(set) var revision: UInt64 = 0
    private(set) var cols = 0
    private(set) var rows = 0
    /// The oldest line held.
    private(set) var origin: UInt64 = 0
    /// One past the newest line.
    private(set) var end: UInt64 = 0
    /// The oldest line the core still keeps.
    private(set) var coreFirst: UInt64 = 0
    private(set) var cursor: Cursor?
    private var held: [UInt64: TerminalLine] = [:]

    /// How many lines are held, from `origin` to `end`.
    var count: Int { Int(end - origin) }

    subscript(index: UInt64) -> TerminalLine? { held[index] }

    /// Takes one update: the lines it carries replace theirs, and every other line keeps what it said.
    mutating func apply(_ update: ScreenUpdate) -> TerminalChanges {
        var changes = TerminalChanges()
        changes.resized = Int(update.cols) != cols
        cols = Int(update.cols)
        rows = Int(update.rows)
        revision = update.revision
        coreFirst = update.firstLine
        if held.isEmpty && end == origin {
            origin = update.firstLine
        }
        if update.lineCount < end {
            for index in max(update.lineCount, origin)..<end { held[index] = nil }
        }
        end = max(update.lineCount, origin)
        for line in update.lines where line.index >= origin && line.index < end {
            held[line.index] = TerminalLine(line)
            changes.lines.append(line.index)
        }
        cursor = update.cursorVisible ? Cursor(line: update.cursorLine, col: Int(update.cursorCol)) : nil
        return changes
    }

    /// Lets go of the lines older than `index`; how many it let go of.
    @discardableResult
    mutating func trim(below index: UInt64) -> UInt64 {
        let next = min(max(origin, index), end)
        guard next > origin else { return 0 }
        for old in origin..<next { held[old] = nil }
        let gone = next - origin
        origin = next
        return gone
    }
}

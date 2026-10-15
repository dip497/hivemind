import SwiftUI

/// How far each level of the tree sits in from the one above it.
private let indentStep: CGFloat = 16

extension HomeEntry {
    /// What names a line of Home in every list it is in, and what the person folds it by.
    var key: String {
        switch self {
        case .machine(let key, _): return key
        case .project(let key, _, _, _, _, _, _): return key
        case .frame(let key, _, _, _, _, _, _, _, _, _): return key
        case .section(let key, _, _, _, _): return key
        case .tile(let key, _, _): return key
        }
    }
}

extension HomeTile {
    /// What its row says under its name: what it waits on (its tool and what about, or its
    /// question), else what it last said, else its state.
    var says: String? {
        if let tool { return about.map { "\(tool): \($0)" } ?? tool }
        if let question { return question }
        if let waits { return NeedsSummary.asked(waits) }
        if let line, !line.isEmpty { return line }
        return state.map(AgentLook.word)
    }

    var needsYou: Bool { state == .waiting }
}

/// A tile's row: its mark in a circle with its state on the corner, its name, what it last said
/// or waits on, for how long, "Needs you" while it waits, and a dot while it is unread.
struct HomeTileRow: View {
    let tile: HomeTile
    let depth: Int
    let mark: AgentMark?
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            TileMark(tile: tile, mark: mark)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(tile.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Look.text)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let since = tile.since {
                        Text(Ago.span(since: since, now: now))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Look.tertiary)
                    }
                }
                HStack(spacing: 8) {
                    Text(tile.says ?? " ")
                        .font(.subheadline)
                        .foregroundStyle(Look.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if tile.needsYou { NeedsYouPill() }
                    if tile.unread {
                        Dot(color: Look.text)
                            .accessibilityLabel("Unread")
                    }
                }
            }
        }
        .padding(.leading, CGFloat(depth) * indentStep)
        .padding(.vertical, 9)
        .background(alignment: .leading) { GuideRails(depth: depth) }
        .contentShape(Rectangle())
    }
}

/// A tile's mark in a circle: its agent's, a terminal for a shell, a window for anything else;
/// a dot on the corner while it works, waits or failed.
struct TileMark: View {
    let tile: HomeTile
    let mark: AgentMark?

    var body: some View {
        ZStack {
            Circle().fill(Look.raised)
            Circle().strokeBorder(Look.hairline, lineWidth: 1)
            if let mark {
                MarkView(mark: mark)
                    .frame(width: 20, height: 20)
            } else {
                Image(systemName: glyph)
                    .font(.system(size: 15, weight: .medium))
            }
        }
        .foregroundStyle(Look.text)
        .frame(width: 38, height: 38)
        .overlay(alignment: .bottomTrailing) {
            if let color = StateDot.color(tile.state) {
                Circle()
                    .fill(color)
                    .frame(width: 10, height: 10)
                    .overlay { Circle().stroke(Look.background, lineWidth: 2) }
                    .offset(x: 1, y: 1)
            }
        }
        .accessibilityHidden(true)
    }

    private var glyph: String {
        if tile.agent { return "sparkle" }
        return tile.kind == "terminal" ? "terminal" : "macwindow"
    }
}

/// The colour of a state's dot: green at work, amber waiting on the person, red once it failed or
/// hit its limit; none otherwise.
enum StateDot {
    static func color(_ state: AgentState?) -> Color? {
        switch state {
        case .working: return Look.done
        case .waiting: return Look.waiting
        case .failed, .limited: return Look.failed
        default: return nil
        }
    }
}

/// "Needs you", in amber.
struct NeedsYouPill: View {
    var body: some View {
        Text("Needs you")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Look.waiting)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Look.waiting.opacity(0.14), in: Capsule())
            .fixedSize()
    }
}

/// What a heading says of what is under it: "Needs you" while something waits, else its dot.
struct StateBadge: View {
    let state: AgentState?

    var body: some View {
        if state == .waiting {
            NeedsYouPill()
        } else if let color = StateDot.color(state) {
            Dot(color: color)
        }
    }
}

/// A heading's count, grey.
struct CountText: View {
    let count: UInt32

    var body: some View {
        Text("\(count)")
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(Look.tertiary)
    }
}

/// The arrow that folds a heading: right when folded, down when open.
struct FoldChevron: View {
    let folded: Bool

    var body: some View {
        Image(systemName: folded ? "chevron.right" : "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Look.tertiary)
            .frame(width: 12)
    }
}

/// Thin lines down the indent, one for each level a row sits under.
struct GuideRails: View {
    let depth: Int

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(0..<max(depth, 0), id: \.self) { level in
                Rectangle()
                    .fill(Look.hairline)
                    .frame(width: 1)
                    .padding(.leading, CGFloat(level) * indentStep + 6)
            }
        }
        .frame(maxHeight: .infinity)
    }
}

/// A project's heading: its fold arrow, its name, what most wants a look, how many, and + to start
/// an agent in it.
struct HomeProjectRow: View {
    let name: String
    let count: UInt32
    let state: AgentState?
    let folded: Bool
    let fold: () -> Void
    let start: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: fold) {
                HStack(spacing: 8) {
                    FoldChevron(folded: folded)
                    Text(name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Look.text)
                        .lineLimit(1)
                    StateBadge(state: state)
                    Spacer(minLength: 4)
                    CountText(count: count)
                }
                .frame(minHeight: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(name)
            .accessibilityValue(folded ? "Folded" : "Open")
            Button(action: start) {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Look.secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start an agent in \(name)")
        }
        .padding(.top, 8)
    }
}

/// A frame's heading: its fold arrow, its folder (open or shut, a branch for a worktree) in its
/// colour, its title, its folder's name when that differs, what most wants a look, how many.
struct HomeFrameRow: View {
    let depth: Int
    let title: String
    let color: String
    let folder: String?
    let worktree: Bool
    let count: UInt32
    let state: AgentState?
    let folded: Bool
    let fold: () -> Void

    var body: some View {
        Button(action: fold) {
            HStack(spacing: 8) {
                FoldChevron(folded: folded)
                FolderMark(open: !folded, worktree: worktree, color: FrameColor.read(color)?.color ?? Look.secondary)
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Look.text)
                    .lineLimit(1)
                if let folder {
                    Text(folder)
                        .font(.caption.monospaced())
                        .foregroundStyle(Look.tertiary)
                        .lineLimit(1)
                }
                StateBadge(state: state)
                Spacer(minLength: 4)
                CountText(count: count)
            }
            .padding(.leading, CGFloat(depth) * indentStep)
            .frame(minHeight: 36)
            .background(alignment: .leading) { GuideRails(depth: depth) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(folded ? "Folded" : "Open")
    }
}

/// A frame's folder in its colour, filled faintly; a branch for a worktree.
struct FolderMark: View {
    let open: Bool
    let worktree: Bool
    let color: Color

    var body: some View {
        ZStack {
            if worktree {
                MarkView(mark: FrameGlyph.branch)
            } else {
                MarkView(mark: FrameGlyph.folder(open: open, filled: true))
                    .foregroundStyle(color.opacity(0.22))
                MarkView(mark: FrameGlyph.folder(open: open, filled: false))
            }
        }
        .foregroundStyle(color)
        .frame(width: 16, height: 16)
    }
}

/// A heading of a grouping that is not the tree (by status, date or agent): small capitals, how
/// many, and its fold arrow.
struct HomeSectionRow: View {
    let label: String
    let count: UInt32
    let state: AgentState?
    let folded: Bool
    let fold: () -> Void

    var body: some View {
        Button(action: fold) {
            HStack(spacing: 8) {
                FoldChevron(folded: folded)
                Text(label.uppercased())
                    .font(.caption.weight(.semibold))
                    .tracking(0.6)
                    .foregroundStyle(Look.secondary)
                    .lineLimit(1)
                StateBadge(state: state)
                Spacer(minLength: 4)
                CountText(count: count)
            }
            .frame(minHeight: 32)
            .padding(.top, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(folded ? "Folded" : "Open")
    }
}

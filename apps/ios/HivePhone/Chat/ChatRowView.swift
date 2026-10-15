import SwiftUI
import UIKit

/// One place in the chat, as SwiftUI draws it: the person's words on the right; the agent's
/// markdown, as the core read it; a tool it used, name · about, with what it gave back folded
/// under it, red when it failed; or the note of why the chat is told no more.
struct ChatRowView: View {
    let item: ChatItem

    var body: some View {
        switch item {
        case .row(let row, let open):
            said(row.said, open: open)
        case .note(let why):
            Label(why, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(Look.tertiary)
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func said(_ said: ChatRow.Said, open: Bool) -> some View {
        switch said {
        case .person(let text):
            HStack {
                Spacer(minLength: 48)
                Text(text)
                    .foregroundStyle(Look.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Look.selected, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        case .agent(let pieces):
            MarkdownView(pieces: pieces)
                .foregroundStyle(Look.text)
        case .tool(let tool, let result):
            ToolRow(tool: tool, result: result, open: open)
        case .result(let result):
            ResultText(result: result)
        }
    }
}

/// What the agent said, its blocks one under the other, a quote's set in after a bar.
private struct MarkdownView: View {
    let pieces: [ChatMarkdown.Piece]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(pieces.indices, id: \.self) { index in
                switch pieces[index] {
                case .block(let block):
                    ListedBlock(block: block)
                case .quote(let inner):
                    // A view in itself: its type is erased.
                    AnyView(MarkdownView(pieces: inner))
                        .padding(.leading, 13)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Look.hairline).frame(width: 3)
                        }
                        .foregroundStyle(Look.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// In a list, a block set in by its depth, after its item's marker when it starts one.
private struct ListedBlock: View {
    let block: TextBlock

    var body: some View {
        if block.depth == 0 {
            BlockView(block: block)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(ChatMarkdown.marker(block.marker))
                    .frame(minWidth: 22, alignment: .leading)
                BlockView(block: block)
            }
            .padding(.leading, CGFloat(block.depth - 1) * 20)
        }
    }
}

/// One block as drawn, in its own direction: text with its styles and links, a heading at its level, code as written
/// under its language, a rule, or a table scrolled across.
private struct BlockView: View {
    let block: TextBlock

    var body: some View {
        switch block.kind {
        case .paragraph(let runs):
            Text(ChatMarkdown.text(runs))
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.layoutDirection, block.rtl ? .rightToLeft : .leftToRight)
        case .heading(let level, let runs):
            Text(ChatMarkdown.text(runs))
                .font(level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.layoutDirection, block.rtl ? .rightToLeft : .leftToRight)
        case .code(let language, let text):
            VStack(alignment: .leading, spacing: 4) {
                if let language {
                    Text(language)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Look.tertiary)
                }
                // As written: its lines are not wrapped, it scrolls across instead.
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .fixedSize()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Look.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .rule:
            Rectangle().fill(Look.hairline).frame(height: 1)
        case .table(let align, let head, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    GridRow {
                        ForEach(head.indices, id: \.self) { column in
                            Text(ChatMarkdown.text(head[column]))
                                .fontWeight(.semibold)
                                .gridColumnAlignment(Self.alignment(align, column))
                        }
                    }
                    ForEach(rows.indices, id: \.self) { row in
                        GridRow {
                            ForEach(rows[row].indices, id: \.self) { column in
                                Text(ChatMarkdown.text(rows[row][column]))
                            }
                        }
                    }
                }
                .font(.footnote)
            }
        }
    }

    private static func alignment(_ align: [ColumnAlign], _ column: Int) -> HorizontalAlignment {
        guard column < align.count else { return .leading }
        switch align[column] {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }
}

/// A tool the agent used, on one line: name · about; what it gave back under it, once unfolded.
private struct ToolRow: View {
    let tool: Tool
    let result: ToolResult?
    let open: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(failed ? Look.failed : Look.tertiary)
                Text(line)
                    .font(.caption.monospaced())
                    .foregroundStyle(Look.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if result != nil {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(Look.tertiary)
                }
            }
            if open, let result {
                ResultText(result: result)
            }
        }
    }

    private var line: String {
        guard let about = tool.about, !about.isEmpty else { return tool.name }
        return "\(tool.name) · \(about)"
    }

    private var failed: Bool {
        result?.error ?? false
    }

    private var icon: String {
        guard let result else { return "ellipsis" }
        return result.error ? "xmark.circle" : "checkmark.circle"
    }
}

/// What a tool gave back: monospace, red when it failed, cut at a screenful.
private struct ResultText: View {
    let result: ToolResult

    var body: some View {
        Text(result.text)
            .font(.caption.monospaced())
            .foregroundStyle(result.error ? Look.failed : Look.secondary)
            .lineLimit(24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(Look.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

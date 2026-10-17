import SwiftUI
import UIKit

/// One place in the chat, as SwiftUI draws it: the person's words on the right; the agent's
/// markdown, as the core read it; a tool it used on one line, red when it failed; the note of why
/// the chat is told no more; or what the agent waits on.
struct ChatRowView: View {
    let item: ChatItem

    var body: some View {
        switch item {
        case .row(let row):
            said(row.said)
        case .wait(let card):
            card
        case .note(let why):
            Label(why, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(Look.tertiary)
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func said(_ said: ChatRow.Said) -> some View {
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
            ToolRow(name: tool.name, about: tool.about, failed: result?.error ?? false)
        case .result(let result):
            ToolRow(name: "Output", about: result.text, failed: result.error)
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

/// A tool the agent used, on one line: its name, then what it is about in mono, a long path cut in
/// the middle so that its file's name shows; red when the use failed. It opens the use.
private struct ToolRow: View {
    let name: String
    let about: String?
    let failed: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(name)
                .font(.subheadline)
                .foregroundStyle(failed ? Look.failed : Look.secondary)
                .lineLimit(1)
                .layoutPriority(1)
            if let about, !about.isEmpty {
                Text(ToolUse.firstLine(of: about))
                    .font(.footnote.monospaced())
                    .foregroundStyle(failed ? Look.failed : Look.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Look.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

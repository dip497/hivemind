import SwiftUI
import UIKit

/// One place in the chat, as SwiftUI draws it: the person's words on the right; the agent's
/// markdown, its code blocks monospace; a tool it used, name · about, with what it gave back folded
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
                .foregroundStyle(.secondary)
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
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.accentColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 16))
            }
        case .agent(let parts):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(parts.indices, id: \.self) { index in
                    MessagePartView(part: parts[index])
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .tool(let tool, let result):
            ToolRow(tool: tool, result: result, open: open)
        case .result(let result):
            ResultText(result: result)
        }
    }
}

/// A piece of what the agent said: its text, as Foundation read the markdown, or a code block.
private struct MessagePartView: View {
    let part: MessagePart

    var body: some View {
        switch part {
        case .text(let text):
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .code(let code):
            Text(code)
                .font(.system(.footnote, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
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
                    .foregroundStyle(failed ? Color.red : Color.secondary)
                Text(line)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                if result != nil {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
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
            .foregroundStyle(result.error ? Color.red : Color.secondary)
            .lineLimit(24)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}

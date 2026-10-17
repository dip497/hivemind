import SwiftUI

/// A tool the agent used, as its chat row opens it: its name, what it was given and what it gave
/// back.
struct ToolUse: Hashable {
    let name: String
    let input: String?
    let result: ToolResult?

    /// What a row shows of a text: its first line.
    static func firstLine(of text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map { String($0) } ?? trimmed
    }
}

/// One use of a tool on its own screen: its input and its output whole, wrapped, selectable; the
/// output red when the use failed.
struct ToolScreen: View {
    let use: ToolUse

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let input = use.input, !input.isEmpty {
                    GroupLabel("Input")
                    ToolText(text: input, failed: false)
                        .padding(.bottom, 8)
                }
                GroupLabel("Output")
                if let result = use.result {
                    ToolText(text: result.text.isEmpty ? "Nothing" : result.text, failed: result.error)
                } else {
                    Text("Nothing yet: it has not finished.")
                        .font(.callout)
                        .foregroundStyle(Look.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(Look.background)
        .navigationTitle(use.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A tool's input or output: monospace, wrapped, selectable.
private struct ToolText: View {
    let text: String
    let failed: Bool

    var body: some View {
        Text(text)
            .font(.footnote.monospaced())
            .foregroundStyle(failed ? Look.failed : Look.text)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .raisedCard()
    }
}

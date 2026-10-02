import Foundation

/// What the agent said, in markdown, cut into the parts the chat draws (design §5.4): text, with its
/// inline styles as Foundation reads them (SwiftUI's Text draws emphasis, code and links itself),
/// and code blocks apart, drawn monospace. Read once, when the entry comes.
enum ChatMarkdown {
    static func parts(_ markdown: String) -> [MessagePart] {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        guard let parsed = try? AttributedString(markdown: markdown, options: options) else {
            return [.text(AttributedString(markdown))]
        }
        var parts: [MessagePart] = []
        var text = AttributedString()
        var code = ""
        // Where the last run was: Foundation keeps blocks as intents, not as line breaks, so a new
        // block is told by its intent's identity.
        var block: Int? = nil
        var item: Int? = nil
        var row: Int? = nil

        func endText() {
            if !text.characters.isEmpty { parts.append(.text(text)) }
            text = AttributedString()
        }
        func endCode() {
            while code.hasSuffix("\n") { code.removeLast() }
            if !code.isEmpty { parts.append(.code(code)) }
            code = ""
        }

        for run in parsed.runs {
            let kinds = run.presentationIntent?.components ?? []
            let leaf = kinds.first { isLeaf($0.kind) }
            let listItem = kinds.first { isListItem($0.kind) }
            let tableRow = kinds.first { isTableRow($0.kind) }
            let piece = AttributedString(parsed[run.range])
            if let leaf, case .codeBlock = leaf.kind {
                if leaf.identity != block {
                    endText()
                    endCode()
                }
                code += String(piece.characters)
            } else {
                // A list item is a block of its own, whether or not its text is a paragraph.
                if leaf?.identity != block || listItem?.identity != item {
                    endCode()
                    if !text.characters.isEmpty {
                        text.append(AttributedString(separator(
                            sameRow: tableRow != nil && tableRow?.identity == row,
                            listGoesOn: listItem != nil && item != nil,
                            tableGoesOn: tableRow != nil && row != nil)))
                    }
                    if let listItem, listItem.identity != item {
                        text.append(AttributedString(marker(listItem, in: kinds)))
                    }
                }
                var styled = piece
                if let leaf, case .header = leaf.kind {
                    styled.inlinePresentationIntent = .stronglyEmphasized
                }
                text.append(styled)
            }
            block = leaf?.identity
            item = listItem?.identity
            row = tableRow?.identity
        }
        endCode()
        endText()
        return parts
    }

    /// Cells of one table row a bar apart; items of one list, and rows of one table, a line apart;
    /// any other block a blank line apart.
    private static func separator(sameRow: Bool, listGoesOn: Bool, tableGoesOn: Bool) -> String {
        if sameRow { return " | " }
        if listGoesOn || tableGoesOn { return "\n" }
        return "\n\n"
    }

    /// "1. " in an ordered list, "• " in any other.
    private static func marker(_ item: PresentationIntent.IntentType, in kinds: [PresentationIntent.IntentType]) -> String {
        let ordered = kinds.contains { component in
            if case .orderedList = component.kind { return true }
            return false
        }
        if ordered, case .listItem(let ordinal) = item.kind {
            return "\(ordinal). "
        }
        return "• "
    }

    /// The blocks text is in: each starts apart from the one before.
    private static func isLeaf(_ kind: PresentationIntent.Kind) -> Bool {
        switch kind {
        case .paragraph, .header, .codeBlock, .tableCell: return true
        default: return false
        }
    }

    private static func isListItem(_ kind: PresentationIntent.Kind) -> Bool {
        if case .listItem = kind { return true }
        return false
    }

    private static func isTableRow(_ kind: PresentationIntent.Kind) -> Bool {
        switch kind {
        case .tableRow, .tableHeaderRow: return true
        default: return false
        }
    }
}

import SwiftUI

/// What an agent changed (design §6.5): how many files, with the lines added and removed in all,
/// then each file with its counts; a file opens to its diff, numbered as the file is.
@MainActor
struct DiffScreen: View {
    let model: PhoneModel
    let agent: AgentRef
    @State private var diff: Diff? = nil
    @State private var failure: String? = nil

    var body: some View {
        Group {
            if let diff {
                List {
                    if diff.files.isEmpty {
                        Text("No changes.")
                            .foregroundStyle(Look.secondary)
                            .pageRow()
                    } else {
                        DiffSummary(files: diff.files)
                            .pageRow()
                    }
                    ForEach(diff.files, id: \.path) { file in
                        NavigationLink {
                            PatchView(path: file.path, patch: diff.patch)
                        } label: {
                            DiffFileRow(file: file)
                        }
                        .pageRow()
                    }
                    if diff.truncated {
                        Text("The diff was cut at 512 KiB.")
                            .font(.footnote)
                            .foregroundStyle(Look.tertiary)
                            .pageRow()
                    }
                }
                .listStyle(.plain)
                .pageGround()
            } else if let failure {
                ContentUnavailableView(
                    "No changes to show", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Look.background)
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                diff = try await model.phone.diff(agent: agent)
            } catch {
                failure = ErrorText.of(error)
            }
        }
    }
}

/// How many files changed, and the lines added and removed in all.
struct DiffSummary: View {
    let files: [DiffFile]

    var body: some View {
        HStack(spacing: 8) {
            Text(files.count == 1 ? "1 file" : "\(files.count) files")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Look.text)
            Spacer(minLength: 8)
            Text("+\(files.reduce(0) { $0 + Int($1.added) })")
                .foregroundStyle(Look.done)
            Text("−\(files.reduce(0) { $0 + Int($1.removed) })")
                .foregroundStyle(Look.failed)
        }
        .font(.footnote.monospaced())
    }
}

/// A changed file: what happened to it (M, A, D, R, ?), its path, and its lines added and removed.
struct DiffFileRow: View {
    let file: DiffFile

    var body: some View {
        HStack(spacing: 10) {
            Text(file.status)
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(Look.tertiary)
                .frame(width: 16)
            Text(file.path)
                .font(.footnote.monospaced())
                .foregroundStyle(Look.text)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            Text("+\(file.added)")
                .foregroundStyle(Look.done)
            Text("−\(file.removed)")
                .foregroundStyle(Look.failed)
        }
        .font(.caption.monospaced())
    }
}

/// One file's diff, a line at a time, each with its number in the file; only the lines in sight are
/// made. Its part of the patch is cut out and numbered once, when the file opens, not for every row
/// of the list that leads to it.
struct PatchView: View {
    let path: String
    let patch: String
    @State private var lines: [Numbered]? = nil

    /// A line of the patch, with its number in the file as it is now (as it was, for a line removed).
    struct Numbered {
        let line: Substring
        let number: Int?
    }

    var body: some View {
        ScrollView {
            if let lines {
                if lines.isEmpty {
                    Text("No diff to show for this file.")
                        .foregroundStyle(Look.secondary)
                        .padding()
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines.indices, id: \.self) { index in
                            let numbered = lines[index]
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(numbered.number.map { String($0) } ?? "")
                                    .foregroundStyle(Look.tertiary)
                                    .frame(width: 36, alignment: .trailing)
                                Text(String(numbered.line))
                                    .foregroundStyle(numbered.line.hasPrefix("@@") ? Look.tertiary : Look.text)
                                    .lineLimit(numbered.line.hasPrefix("@@") ? 1 : nil)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .font(.system(.caption, design: .monospaced))
                            .padding(.trailing, 12)
                            .padding(.vertical, 1)
                            .background(Self.paint(numbered.line))
                        }
                    }
                }
            }
        }
        .background(Look.background)
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if lines == nil {
                let section = PatchFiles.section(of: path, in: patch)?
                    .split(separator: "\n", omittingEmptySubsequences: false) ?? []
                lines = Self.numbered(section)
            }
        }
    }

    /// A file's patch, its header lines left out (the screen names the file), each line numbered.
    private static func numbered(_ lines: [Substring]) -> [Numbered] {
        var old = 0
        var new = 0
        var inHunk = false
        var numbered: [Numbered] = []
        for line in lines {
            if line.hasPrefix("@@") {
                let (from, to) = starts(line)
                old = from
                new = to
                inHunk = true
                numbered.append(Numbered(line: line, number: nil))
            } else if !inHunk {
                continue
            } else if line.hasPrefix("+") {
                numbered.append(Numbered(line: line, number: new))
                new += 1
            } else if line.hasPrefix("-") {
                numbered.append(Numbered(line: line, number: old))
                old += 1
            } else if line.hasPrefix("\\") {
                numbered.append(Numbered(line: line, number: nil))
            } else {
                numbered.append(Numbered(line: line, number: new))
                new += 1
                old += 1
            }
        }
        return numbered
    }

    /// Where a hunk starts in the old file and the new: `@@ -12,7 +12,9 @@` is 12 and 12.
    private static func starts(_ header: Substring) -> (Int, Int) {
        var from = 0
        var to = 0
        for word in header.split(separator: " ") {
            let digits = word.dropFirst().prefix { $0.isNumber }
            if word.hasPrefix("-"), let number = Int(digits) { from = number }
            if word.hasPrefix("+"), let number = Int(digits) { to = number }
        }
        return (from, to)
    }

    private static func paint(_ line: Substring) -> Color {
        if line.hasPrefix("@@") { return Look.raised }
        if line.hasPrefix("+") { return Look.done.opacity(0.10) }
        if line.hasPrefix("-") { return Look.failed.opacity(0.10) }
        return .clear
    }
}

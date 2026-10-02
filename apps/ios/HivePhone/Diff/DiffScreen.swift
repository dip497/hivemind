import SwiftUI

/// What an agent changed (design §6.5): the files with their counts; a file opens to its diff.
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
                        Text("No changes.").foregroundStyle(.secondary)
                    }
                    ForEach(diff.files, id: \.path) { file in
                        NavigationLink {
                            PatchView(path: file.path, patch: diff.patch)
                        } label: {
                            DiffFileRow(file: file)
                        }
                    }
                    if diff.truncated {
                        Text("The diff was cut at 512 KiB.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if let failure {
                ContentUnavailableView(
                    "No changes to show", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView()
            }
        }
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

/// A changed file: what happened to it (M, A, D, R, ?), its path, and its lines added and removed.
struct DiffFileRow: View {
    let file: DiffFile

    var body: some View {
        HStack(spacing: 10) {
            Text(file.status)
                .font(.caption.monospaced().weight(.bold))
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(file.path)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            Text("+\(file.added)")
                .foregroundStyle(.green)
            Text("−\(file.removed)")
                .foregroundStyle(.red)
        }
        .font(.callout.monospacedDigit())
    }
}

/// One file's diff, a line at a time; only the lines in sight are made. Its part of the patch is
/// cut out once, when the file opens, not for every row of the list that leads to it.
struct PatchView: View {
    let path: String
    let patch: String
    @State private var lines: [Substring]? = nil

    var body: some View {
        ScrollView {
            if let lines {
                if lines.isEmpty {
                    Text("No diff to show for this file.")
                        .foregroundStyle(.secondary)
                        .padding()
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines.indices, id: \.self) { index in
                            Text(String(lines[index]))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Self.ink(lines[index]))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10)
                                .background(Self.paint(lines[index]))
                        }
                    }
                }
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if lines == nil {
                lines = PatchFiles.section(of: path, in: patch)?
                    .split(separator: "\n", omittingEmptySubsequences: false) ?? []
            }
        }
    }

    private static func ink(_ line: Substring) -> Color {
        if line.hasPrefix("@@") { return .blue }
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .green }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .red }
        return .primary
    }

    private static func paint(_ line: Substring) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return Color.green.opacity(0.08) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return Color.red.opacity(0.08) }
        return .clear
    }
}

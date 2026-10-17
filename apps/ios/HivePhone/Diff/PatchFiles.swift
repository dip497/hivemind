import Foundation

/// A unified diff cut into its files (design §6.5): a file opens to its own part of the patch.
enum PatchFiles {
    /// The part of `patch` about `path`: from the `diff --git` line that names it as the new side to
    /// the next file's; nil when the patch has none (a binary file, or the patch was cut short).
    static func section(of path: String, in patch: String) -> String? {
        let header = " b/" + path
        var lines: [Substring] = []
        var inside = false
        for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("diff --git ") {
                if inside { break }
                inside = line.hasSuffix(header)
            }
            if inside { lines.append(line) }
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }
}

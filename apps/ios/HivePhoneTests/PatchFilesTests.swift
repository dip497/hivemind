import XCTest
@testable import HivePhone

/// A changed file opens to its own part of the agent's diff (design §6.5).
final class PatchFilesTests: XCTestCase {
    private let patch = """
        diff --git a/src/data.txt b/src/data.txt
        --- a/src/data.txt
        +++ b/src/data.txt
        @@ -1 +1 @@
        -old
        +new
        diff --git a/a.txt b/a.txt
        new file mode 100644
        --- /dev/null
        +++ b/a.txt
        @@ -0,0 +1 @@
        +hello
        """

    func testAFileOpensToItsOwnPartOfThePatch() {
        XCTAssertEqual(PatchFiles.section(of: "src/data.txt", in: patch), """
            diff --git a/src/data.txt b/src/data.txt
            --- a/src/data.txt
            +++ b/src/data.txt
            @@ -1 +1 @@
            -old
            +new
            """)
        // "src/data.txt" ends in "a.txt": the file is named by its whole path.
        XCTAssertEqual(PatchFiles.section(of: "a.txt", in: patch), """
            diff --git a/a.txt b/a.txt
            new file mode 100644
            --- /dev/null
            +++ b/a.txt
            @@ -0,0 +1 @@
            +hello
            """)
        XCTAssertNil(PatchFiles.section(of: "data.txt", in: patch))
    }
}

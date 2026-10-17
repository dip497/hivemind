package com.hivemind.phone.ui.diff

import org.junit.Assert.assertEquals
import org.junit.Test

/** The core's one patch, cut into each file's part for the Diff screen (design §6.5). */
class PatchesTest {
    @Test
    fun `each file's part is found by the path the core lists the file under`() {
        val modified = """
            diff --git a/src/main.rs b/src/main.rs
            index 3b18e51..a4c0c3e 100644
            --- a/src/main.rs
            +++ b/src/main.rs
            @@ -1 +1 @@
            -fn main() {}
            +fn main() { run() }
        """.trimIndent()
        val renamed = """
            diff --git a/notes/old name.md b/notes/new name.md
            similarity index 100%
            rename from notes/old name.md
            rename to notes/new name.md
        """.trimIndent()
        val deleted = """
            diff --git a/gone.txt b/gone.txt
            deleted file mode 100644
            --- a/gone.txt
            +++ /dev/null
            @@ -1 +0,0 @@
            -bye
        """.trimIndent()

        val parts = patchesByFile("$modified\n$renamed\n$deleted\n")

        assertEquals(listOf("src/main.rs", "notes/new name.md", "gone.txt"), parts.keys.toList())
        assertEquals(listOf(modified, renamed, deleted), parts.values.toList())
    }
}

package com.hivemind.phone.ui.agent

import org.junit.Assert.assertEquals
import org.junit.Test

/** What the Type box sends the terminal as its text changes (design §6.4). */
class TypingTest {
    @Test
    fun `each change types what was added, after a backspace a character taken off the end`() {
        val cases = listOf(
            Triple("ls", "ls -la", Typing(0, " -la")),
            Triple("ls -la", "ls -l", Typing(1, "")),
            // An autocorrect rewriting the word typed so far.
            Triple("git sttaus", "git status", Typing(4, "atus")),
            // One character in two UTF-16 units, taken back with one backspace.
            Triple("ok 👍", "ok ", Typing(1, "")),
        )
        for ((before, after, expected) in cases) assertEquals("$before -> $after", expected, typing(before, after))
    }
}

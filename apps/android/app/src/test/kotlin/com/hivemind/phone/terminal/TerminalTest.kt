package com.hivemind.phone.terminal

import com.hivemind.phone.line
import com.hivemind.phone.update
import org.junit.Assert.assertEquals
import org.junit.Test

/** The terminal as the phone draws it, kept from the core's updates (design §5.3). */
class TerminalTest {
    private fun Terminal.texts() = (0 until lineCount).map { slot(it).line.text }

    @Test
    fun `an update replaces the lines it names, by index, and keeps the rest`() {
        val terminal = Terminal()
        terminal.apply(update(1, first = 0, count = 3, lines = listOf(line(0, "$ ls"), line(1, "a.txt"), line(2, "$"))))
        terminal.apply(update(2, first = 0, count = 3, lines = listOf(line(1, "b.txt"))))

        assertEquals(listOf("$ ls", "b.txt", "$"), terminal.texts())
        assertEquals(2uL, terminal.revision)
    }

    @Test
    fun `lines the scrollback lets go leave from the front, and the rest keep their index`() {
        val terminal = Terminal()
        terminal.apply(update(1, first = 0, count = 4, lines = (0L..3L).map { line(it, "line $it") }))
        terminal.apply(update(2, first = 2, count = 6, lines = listOf(line(4, "line 4"), line(5, "line 5"))))

        assertEquals(2L, terminal.firstLine)
        assertEquals(listOf("line 2", "line 3", "line 4", "line 5"), terminal.texts())
    }

    @Test
    fun `a watch the core resumed, from a fresh screen, replaces what was drawn`() {
        val terminal = Terminal()
        terminal.apply(update(50, first = 10, count = 40, lines = (10L until 40L).map { line(it, "before $it") }))
        // Lines numbered afresh, every one sent, the revisions begun again.
        terminal.apply(update(3, first = 0, count = 3, lines = (0L until 3L).map { line(it, "after $it") }))

        assertEquals(listOf("after 0", "after 1", "after 2"), terminal.texts())
        assertEquals(0L, terminal.firstLine)
        assertEquals(3uL, terminal.revision)
    }

    @Test
    fun `the cursor is on one line at a time, and on none while hidden`() {
        val terminal = Terminal()
        val lines = (0L..2L).map { line(it, "$") }
        terminal.apply(update(1, first = 0, count = 3, lines = lines, cursorLine = 1, cursorCol = 2, cursorVisible = true))
        terminal.apply(update(2, first = 0, count = 3, lines = emptyList(), cursorLine = 2, cursorCol = 5, cursorVisible = true))

        assertEquals(listOf(-1, -1, 5), (0..2).map { terminal.slot(it).cursor })

        terminal.apply(update(3, first = 0, count = 3, lines = emptyList(), cursorLine = 2, cursorCol = 5, cursorVisible = false))
        assertEquals(listOf(-1, -1, -1), (0..2).map { terminal.slot(it).cursor })
    }

    @Test
    fun `the view follows the newest line until the person scrolls up`() {
        val terminal = Terminal()
        terminal.apply(update(1, first = 0, count = 30, lines = (0L until 30L).map { line(it, "$it") }))
        assertEquals(29, terminal.list.firstVisibleItemIndex)

        terminal.following = false
        terminal.apply(update(2, first = 0, count = 40, lines = (30L until 40L).map { line(it, "$it") }))
        assertEquals(29, terminal.list.firstVisibleItemIndex)
    }
}

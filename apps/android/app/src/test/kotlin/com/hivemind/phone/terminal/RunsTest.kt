package com.hivemind.phone.terminal

import com.hivemind.phone.palette
import com.hivemind.phone.rgb
import com.hivemind.phone.run
import com.hivemind.phone.runs
import org.junit.Assert.assertEquals
import org.junit.Test

/** The packed runs of design §5.3, as the core sends them, decoded. */
class RunsTest {
    @Test
    fun `each 16-byte run decodes to its start, length, column, flags and colours`() {
        // Values past one byte, so a field read big-endian, or at the wrong offset, shows.
        val text = "x".repeat(400)
        val decoded = Runs.decode(
            runs(
                run(start = 0, len = 2, col = 0, flags = RunFlags.BOLD, fg = palette(9), bg = 0),
                run(start = 300, len = 70, col = 258, flags = RunFlags.UNDERLINE or RunFlags.INVERSE, fg = rgb(0x123456), bg = palette(240)),
            ),
            text,
        )

        assertEquals(2, decoded.count)
        assertEquals(listOf(0, 2, 0, RunFlags.BOLD, palette(9), 0), fields(decoded, 0))
        assertEquals(
            listOf(300, 370, 258, RunFlags.UNDERLINE or RunFlags.INVERSE, rgb(0x123456), palette(240)),
            fields(decoded, 1),
        )
    }

    @Test
    fun `a run covers a cell a character, and a wide one two`() {
        // "𝑥" is one character in two UTF-16 units; "漢" is a double-width character, a run of its own.
        val text = "a𝑥b漢"
        val decoded = Runs.decode(runs(run(0, 4, 0), run(4, 1, 3, flags = RunFlags.WIDE)), text)

        assertEquals(3, decoded.cells(0))
        assertEquals(2, decoded.cells(1))
    }

    @Test
    fun `a run reaching past its line's text is cut to it, and one past the end dropped`() {
        val decoded = Runs.decode(runs(run(1, 10, 1), run(5, 1, 5)), "abc")

        assertEquals(1, decoded.count)
        assertEquals(1, decoded.start(0))
        assertEquals(3, decoded.end(0))
    }

    private fun fields(runs: Runs, run: Int) =
        listOf(runs.start(run), runs.end(run), runs.col(run), runs.flags(run), runs.fg(run), runs.bg(run))
}

package com.hivemind.phone.terminal

import android.graphics.Bitmap
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.line
import com.hivemind.phone.palette
import com.hivemind.phone.rgb
import com.hivemind.phone.run
import com.hivemind.phone.runs
import com.hivemind.phone.update
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The terminal as drawn: each run at its column times the cell width (design §5.3), following the
 * newest line until the person scrolls up (§6.4): the newer of the cursor's line and the last line
 * written, kept the last in sight.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "mdpi")
class TerminalViewTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `each run's background is painted over its own cells, at its column`() {
        // 10 columns across 200 px: 20 px a cell. The text's offsets in the line are not its
        // columns: "cd" is the 4th and 5th character, drawn from column 6.
        val terminal = Terminal()
        terminal.apply(
            update(
                1, first = 0, count = 1, cols = 10, rows = 1,
                lines = listOf(
                    line(
                        0,
                        "ab cd e",
                        runs(
                            run(0, 2, 0),
                            run(3, 2, 6, bg = rgb(0xC03030)),
                            run(6, 1, 9, flags = RunFlags.INVERSE),
                            run(2, 1, 3, bg = palette(4)),
                        ),
                    ),
                ),
            ),
        )
        compose.setContent { TerminalView(terminal, Modifier.size(200.dp, 80.dp)) }

        val image = compose.onRoot().captureToImage().asAndroidBitmap()
        val signal = TermPalette.SIGNAL
        assertEquals(
            listOf(
                signal.background, // column 2: no run there
                0xFF7D9BC4.toInt(), // column 3: palette blue behind a space
                signal.background, // column 5
                0xFFC03030.toInt(), // columns 6 and 7: "cd"
                0xFFC03030.toInt(),
                signal.background, // column 8
                signal.foreground, // column 9: inverse, the default text colour behind it
            ),
            listOf(2, 3, 5, 6, 7, 8, 9).map { image.cell(it) },
        )
    }

    @Test
    fun `a finger scrolling up stops the following, and the button goes back to the newest line`() {
        val terminal = Terminal()
        terminal.apply(update(1, first = 0, count = 60, cols = 10, rows = 60, lines = (0L until 60L).map { line(it, "$it") }))
        compose.setContent { TerminalView(terminal, Modifier.size(200.dp, 120.dp)) }

        compose.onRoot().performTouchInput { swipeDown() }
        compose.waitForIdle()
        assertFalse(terminal.follow.on)
        assertTrue(terminal.follow.list.layoutInfo.visibleItemsInfo.last().index < 59)

        compose.onNodeWithContentDescription("To the newest").performClick()
        compose.waitForIdle()
        assertTrue(terminal.follow.on)
        assertEquals(59, terminal.follow.list.layoutInfo.visibleItemsInfo.last().index)

        // Up again, back again, and output lands before the view has moved: it follows that too.
        compose.onRoot().performTouchInput { swipeDown() }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("To the newest").performClick()
        terminal.apply(update(2, first = 0, count = 70, cols = 10, rows = 60, lines = (60L until 70L).map { line(it, "$it") }))
        compose.waitForIdle()
        assertTrue(terminal.follow.on)
        assertEquals(69, terminal.follow.list.layoutInfo.visibleItemsInfo.last().index)
    }

    @Test
    fun `a screen still filling from the top is followed where it is written, at the cursor's line or, the cursor hidden, the last line written`() {
        // A session 40 rows tall in a view five lines tall (a phone's, the keyboard up): the
        // talker's lines at the top, the cursor under them, and the blank rows below.
        val written = listOf("talker> fix the nav", "heard: fix the nav", "Priya says ship it", "heard: Priya says ship it")
        val screen = written.mapIndexed { i, text -> line(i.toLong(), text) } + (4L until 40L).map { line(it, "", runs()) }
        val terminal = Terminal()
        terminal.apply(update(1, first = 0, count = 40, rows = 40, lines = screen, cursorLine = 4, cursorVisible = true))
        compose.setContent { TerminalView(terminal, Modifier.size(200.dp, 100.dp)) }
        compose.onNodeWithText("heard: Priya says ship it").assertIsDisplayed()

        // The cursor hidden at the bottom, as a program leaves it while it draws: the last line written.
        terminal.apply(update(2, first = 0, count = 40, rows = 40, lines = emptyList(), cursorLine = 39, cursorVisible = false))
        compose.waitForIdle()
        compose.onNodeWithText("heard: Priya says ship it").assertIsDisplayed()

        // The cursor shown further down than anything written, blank lines printed above it: its line.
        terminal.apply(update(3, first = 0, count = 40, rows = 40, lines = emptyList(), cursorLine = 30, cursorVisible = true))
        compose.waitForIdle()
        assertTrue(terminal.follow.list.layoutInfo.visibleItemsInfo.any { it.index == 30 })
    }

    @Test
    fun `a full screen is followed at its bottom, below the cursor`() {
        // A program drawing the whole screen: its input box, with the cursor in it, above its status.
        val terminal = Terminal()
        terminal.apply(
            update(1, first = 0, count = 40, rows = 40, lines = (0L until 40L).map { line(it, "row $it") }, cursorLine = 36, cursorVisible = true),
        )
        compose.setContent { TerminalView(terminal, Modifier.size(200.dp, 100.dp)) }

        compose.onNodeWithText("row 39").assertIsDisplayed()
    }

    @Test
    fun `the view made shorter, as the keyboard makes it, keeps the newest line in sight`() {
        val terminal = Terminal()
        terminal.apply(update(1, first = 0, count = 8, rows = 8, lines = (0L until 8L).map { line(it, "row $it") }))
        var height by mutableStateOf(300.dp)
        compose.setContent { TerminalView(terminal, Modifier.size(200.dp, height)) }
        compose.onNodeWithText("row 0").assertIsDisplayed()

        height = 60.dp
        compose.waitForIdle()
        compose.onNodeWithText("row 7").assertIsDisplayed()
    }

    // A cell's colour at its top-left corner, away from any glyph.
    private fun Bitmap.cell(col: Int) = getPixel(col * 20 + 1, 1)
}

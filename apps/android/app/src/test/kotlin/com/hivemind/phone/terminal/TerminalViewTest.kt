package com.hivemind.phone.terminal

import android.graphics.Bitmap
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.line
import com.hivemind.phone.palette
import com.hivemind.phone.rgb
import com.hivemind.phone.run
import com.hivemind.phone.runs
import com.hivemind.phone.update
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The terminal as drawn: each run at its column times the cell width (design §5.3). */
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

    // A cell's colour at its top-left corner, away from any glyph.
    private fun Bitmap.cell(col: Int) = getPixel(col * 20 + 1, 1)
}

package com.hivemind.phone.ui.home

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.AgentMark
import com.hivemind.phone.core.MarkShape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** An agent's mark, as the core sends it, drawn into a row's circle. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MarksTest {
    private fun shape(d: String, fill: Boolean = true, evenOdd: Boolean = false, stroke: Double = 0.0, fillColor: String? = null) =
        MarkShape(d = d, fill = fill, fillColor = fillColor, evenOdd = evenOdd, stroke = stroke, strokeColor = null, round = false, opacity = 1.0)

    /** A 10-wide square with a 4-wide hole in its middle, in a box that starts at 10, 10. */
    private fun ring(evenOdd: Boolean) = AgentMark(
        x = 10.0, y = 10.0, width = 10.0, height = 10.0,
        shapes = listOf(shape("M10 10 L20 10 L20 20 L10 20 Z M13 13 L17 13 L17 17 L13 17 Z", evenOdd = evenOdd)),
    )

    private fun drawn(mark: AgentMark, side: Int = 40): (Int, Int) -> Color {
        val bitmap = ImageBitmap(side, side)
        CanvasDrawScope().draw(Density(1f), LayoutDirection.Ltr, Canvas(bitmap), Size(side.toFloat(), side.toFloat())) {
            drawMark(MarkCache().of("agent", mark), Color.Black, side.toFloat())
        }
        val pixels = bitmap.toPixelMap()
        return { x, y -> pixels[x, y] }
    }

    @Test
    fun `a mark fills the circle's square from its own box, and one wider than tall is centred top to bottom`() {
        assertEquals(MarkPlacement(scale = 4f, left = -40f, top = -40f), placeMark(ring(false), 40f))

        val wide = AgentMark(x = 26.3, y = 26.3, width = 54.0, height = 27.0, shapes = emptyList())
        val placed = placeMark(wide, 54f)
        assertEquals(1f, placed.scale, 1e-4f)
        assertEquals(-26.3f, placed.left, 1e-4f)
        assertEquals(-26.3f + 13.5f, placed.top, 1e-4f)
    }

    @Test
    fun `a mark drawn by the even-odd rule leaves its hole empty, and by the nonzero rule fills it`() {
        val holed = drawn(ring(evenOdd = true))
        assertEquals("the ring itself is drawn", Color.Black, holed(4, 4))
        assertEquals("the hole is left empty", 0f, holed(20, 20).alpha)

        assertEquals(Color.Black, drawn(ring(evenOdd = false))(20, 20))
    }

    @Test
    fun `a shape in its brand's colour is drawn in it, and one with none in the row's colour`() {
        val two = AgentMark(
            0.0, 0.0, 10.0, 10.0,
            listOf(shape("M0 0 L5 0 L5 10 L0 10 Z", fillColor = "#d97757"), shape("M5 0 L10 0 L10 10 L5 10 Z")),
        )
        val drawnTwo = drawn(two)
        assertEquals(Color(0xFFD97757), drawnTwo(10, 20))
        assertEquals(Color.Black, drawnTwo(30, 20))
    }

    @Test
    fun `an outline only is drawn as a line, its inside left empty`() {
        val outline = AgentMark(0.0, 0.0, 10.0, 10.0, listOf(shape("M1 1 L9 1 L9 9 L1 9 Z", fill = false, stroke = 1.0)))
        val drawnOutline = drawn(outline)
        assertNotEquals("its edge", 0f, drawnOutline(4, 20).alpha)
        assertEquals("its inside", 0f, drawnOutline(20, 20).alpha)
    }

    @Test
    fun `an agent's mark is read once however many rows draw it, and again when it changes`() {
        val cache = MarkCache()
        val first = cache.of("claude", ring(true))
        assertSame(first, cache.of("claude", ring(true)))
        assertNotEquals(first, cache.of("claude", ring(false)))
    }
}

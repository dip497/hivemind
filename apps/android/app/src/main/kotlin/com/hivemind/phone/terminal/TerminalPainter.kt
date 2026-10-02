package com.hivemind.phone.terminal

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.runtime.Immutable
import kotlin.math.ceil

/** A terminal's cells at one size, in pixels: what a line's text is drawn at. */
@Immutable
data class Cells(val textSize: Float, val width: Float, val height: Float, val baseline: Float)

/**
 * Draws terminal lines on a native canvas, each run at `col × cell width` (design §5.3). A Paint is
 * made for a text style the first time it is drawn and kept, and the font is measured once, at a
 * reference size every other size is a multiple of: nothing is measured per frame (design §3.5).
 *
 * [typefaces] are the monospace face regular, bold, italic and bold italic, in that order.
 */
class TerminalPainter(private val typefaces: List<Typeface>, private val palette: TermPalette) {
    // Per pixel of text size: the cell's width, and the font's ascent and descent.
    private val advance: Float
    private val ascent: Float
    private val descent: Float

    init {
        val probe = textPaint(typefaces[0]).apply { textSize = REFERENCE }
        advance = probe.measureText("M") / REFERENCE
        val metrics = probe.fontMetrics
        ascent = -metrics.ascent / REFERENCE
        descent = metrics.descent / REFERENCE
    }

    // One a style: bold, italic, underline and strikethrough as the four bits of its slot.
    private val styled = arrayOfNulls<Paint>(16)
    private val fill = Paint()

    /** Cells [width] pixels wide, the text sized to fill them. */
    fun cells(width: Float): Cells {
        val textSize = width / advance
        return Cells(textSize, width, ceil(textSize * (ascent + descent)), textSize * ascent)
    }

    /** Draws [line] from the canvas's origin, with the cursor on cell [cursor] (none when -1). */
    fun draw(canvas: Canvas, line: TermLine, cursor: Int, cells: Cells) {
        val runs = line.runs
        // Every run's paper first, then the text, so a wide character's glyph is not painted over
        // by the next run's background.
        for (run in 0 until runs.count) {
            val flags = runs.flags(run)
            val paper = if (flags and RunFlags.INVERSE != 0) {
                palette.ink(runs.fg(run))
            } else {
                palette.paper(runs.bg(run))
            }
            if (paper == TermPalette.NONE) continue
            val x = runs.col(run) * cells.width
            fill.color = paper
            canvas.drawRect(x, 0f, x + runs.cells(run) * cells.width, cells.height, fill)
        }
        for (run in 0 until runs.count) {
            val flags = runs.flags(run)
            if (flags and RunFlags.HIDDEN != 0) continue
            var ink = if (flags and RunFlags.INVERSE != 0) {
                val paper = palette.paper(runs.bg(run))
                if (paper == TermPalette.NONE) palette.background else paper
            } else {
                palette.ink(runs.fg(run))
            }
            if (flags and RunFlags.DIM != 0) ink = (ink and 0x00FFFFFF) or (DIM_ALPHA shl 24)
            val paint = styled(flags)
            paint.textSize = cells.textSize
            paint.color = ink
            canvas.drawText(line.text, runs.start(run), runs.end(run), runs.col(run) * cells.width, cells.baseline, paint)
        }
        if (cursor >= 0) {
            fill.color = (palette.cursor and 0x00FFFFFF) or (CURSOR_ALPHA shl 24)
            canvas.drawRect(cursor * cells.width, 0f, (cursor + 1) * cells.width, cells.height, fill)
        }
    }

    private fun styled(flags: Int): Paint {
        val style = (if (flags and RunFlags.BOLD != 0) 1 else 0) or
            (if (flags and RunFlags.ITALIC != 0) 2 else 0) or
            (if (flags and RunFlags.UNDERLINE != 0) 4 else 0) or
            (if (flags and RunFlags.STRIKETHROUGH != 0) 8 else 0)
        return styled[style] ?: textPaint(typefaces[style and 3]).apply {
            isUnderlineText = style and 4 != 0
            isStrikeThruText = style and 8 != 0
        }.also { styled[style] = it }
    }

    private companion object {
        const val REFERENCE = 100f
        const val DIM_ALPHA = 0x99
        const val CURSOR_ALPHA = 0x8C

        // Linear and subpixel text: advances scale exactly with the text size, so a run's
        // characters land on its cells at every zoom.
        fun textPaint(typeface: Typeface) =
            Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG or Paint.LINEAR_TEXT_FLAG).apply {
                this.typeface = typeface
            }
    }
}

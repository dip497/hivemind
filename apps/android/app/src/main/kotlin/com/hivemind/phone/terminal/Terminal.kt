package com.hivemind.phone.terminal

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.ScreenUpdate
import com.hivemind.phone.ui.common.Follow

/** A line as drawn: its text, and its runs decoded. */
@Immutable
class TermLine(val text: String, val runs: Runs) {
    companion object {
        val BLANK = TermLine("", Runs.NONE)
    }
}

/**
 * One line's place on the screen. Drawing reads its line and its cursor, so a change to one line
 * redraws that line alone.
 */
@Stable
class LineSlot {
    var line: TermLine by mutableStateOf(TermLine.BLANK)
        internal set

    /** The cell the cursor is on, on this line; -1 when it is on another or hidden. */
    var cursor: Int by mutableIntStateOf(-1)
        internal set
}

/**
 * An agent's terminal as the phone shows it: the lines the core keeps (scrollback and screen), each
 * named by its index since the watch began, the cursor, and where the view is. It changes only by
 * [apply], once a frame, with what changed since the revision last drawn.
 */
@Stable
class Terminal {
    /** The revision drawn: the next update is asked for what changed since. */
    var revision: ULong = 0u
        private set

    /** The session's size. Its owner sizes it; the phone never reflows it (design §3.6). */
    var cols by mutableIntStateOf(0)
        private set
    var rows by mutableIntStateOf(0)
        private set

    /** The index of the oldest line kept. */
    var firstLine by mutableLongStateOf(0L)
        private set

    /** How many lines are kept, from [firstLine] on. */
    var lineCount by mutableIntStateOf(0)
        private set

    private val slots = ArrayDeque<LineSlot>()
    private var cursorSlot: LineSlot? = null

    /** Where the view is, following the newest line: kept here, so an update and the scroll it brings land in one frame. */
    val follow = Follow()

    /** The line [position] lines after [firstLine]. */
    fun slot(position: Int): LineSlot = slots[position]

    fun apply(update: ScreenUpdate) {
        revision = update.revision
        cols = update.cols.toInt()
        rows = update.rows.toInt()

        val first = update.firstLine.toLong()
        val count = (update.lineCount.toLong() - first).coerceAtLeast(0).toInt()
        // Lines the scrollback let go leave from the front; every other line keeps its slot, and so
        // its place in the view.
        val gone = first - firstLine
        if (gone < 0 || gone >= slots.size) slots.clear() else repeat(gone.toInt()) { slots.removeFirst() }
        firstLine = first
        while (slots.size > count) slots.removeLast()
        while (slots.size < count) slots.addLast(LineSlot())

        for (line in update.lines) {
            val position = line.index.toLong() - first
            if (position in 0 until count) {
                slots[position.toInt()].line = TermLine(line.text, Runs.decode(line.runs, line.text))
            }
        }

        cursorSlot?.cursor = -1
        val cursorAt = update.cursorLine.toLong() - first
        cursorSlot = if (update.cursorVisible && cursorAt in 0 until count) {
            slots[cursorAt.toInt()].also { it.cursor = update.cursorCol.toInt() }
        } else {
            null
        }

        lineCount = count
        follow.grew(count - 1)
    }
}

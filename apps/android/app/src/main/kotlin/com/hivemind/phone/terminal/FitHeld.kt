package com.hivemind.phone.terminal

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Whether the session still has the size the phone fitted it to. Once it took that size, another
 * size means another screen took it back (someone typed there, or asked for their window's size).
 */
@Stable
class FitHeld {
    /** The size fitted to, while the phone holds one. */
    var size: TermSize? = null
        private set
    private var reached = false

    var takenBack by mutableStateOf(false)
        private set

    /** The phone asked for [size]: not taken back until the session has had it. */
    fun asked(size: TermSize) {
        this.size = size
        reached = false
        takenBack = false
    }

    /** The phone let go of its size. */
    fun letGo() {
        size = null
        reached = false
        takenBack = false
    }

    /** The session is [cols] × [rows] now. */
    fun sized(cols: Int, rows: Int) {
        val asked = size ?: return
        if (cols == asked.cols && rows == asked.rows) {
            reached = true
        } else if (reached) {
            reached = false
            takenBack = true
        }
    }
}

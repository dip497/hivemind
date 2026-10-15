package com.hivemind.phone.terminal

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FitHeldTest {
    @Test
    fun `the size is taken back only once the session had the phone's size and then another`() {
        val held = FitHeld()
        held.asked(TermSize(48, 30))
        // The computer's size, before the session took the phone's: no one took it back yet.
        held.sized(120, 40)
        assertFalse(held.takenBack)
        held.sized(48, 30)
        assertFalse(held.takenBack)
        held.sized(120, 40)
        assertTrue(held.takenBack)
        // Fitted again: the old size is not taken back until the new one is had.
        held.asked(TermSize(48, 30))
        assertFalse(held.takenBack)
        held.sized(120, 40)
        assertFalse(held.takenBack)
    }

    @Test
    fun `let go, a size the session takes is nobody taking anything back`() {
        val held = FitHeld()
        held.asked(TermSize(48, 30))
        held.sized(48, 30)
        held.letGo()
        held.sized(120, 40)
        assertFalse(held.takenBack)
    }
}

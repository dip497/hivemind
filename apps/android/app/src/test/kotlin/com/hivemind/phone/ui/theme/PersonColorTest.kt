package com.hivemind.phone.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

/** The person's colour as `Person.color` carries it (design §5.2): `#rrggbb`, or "" for none. */
class PersonColorTest {
    @Test
    fun `a colour is read from #rrggbb, and anything else is no colour rather than a crash`() {
        val cases = mapOf(
            "#3a7bd5" to Color(0xFF3A7BD5),
            "#E6B45E" to Color(0xFFE6B45E),
            "" to null,
            "3a7bd5" to null,
            "#3a7bd" to null,
            "#-12345" to null,
            "#3a7bzz" to null,
        )
        for ((hex, colour) in cases) assertEquals(hex, colour, personColor(hex))
    }
}

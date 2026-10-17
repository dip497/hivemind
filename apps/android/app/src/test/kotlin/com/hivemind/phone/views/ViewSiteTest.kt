package com.hivemind.phone.views

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Where each view's page lives on the phone (design §6.1): an origin of its own, and only it is the view. */
@RunWith(AndroidJUnit4::class)
class ViewSiteTest {
    @Test
    fun `a view's origin is its id as the view SDK makes a hostname of it, and what is no view's id has none`() {
        val origins = listOf("phone-probe", "@dip497/board", "b2", "Board", "a--b", "@dip497/board/x", "a.b", "a/b", "x".repeat(64), "@${"o".repeat(30)}/${"n".repeat(33)}")
            .map { ViewSite.of(it)?.origin }

        assertEquals(
            listOf(
                "https://phone-probe.views.hivemind.invalid",
                "https://dip497--board.views.hivemind.invalid",
                "https://b2.views.hivemind.invalid",
                null, null, null, null, null, null, null,
            ),
            origins,
        )
    }

    @Test
    fun `only the main frame of the view's own origin is the view`() {
        val site = ViewSite.of("phone-probe")!!
        val from = listOf(
            "https://phone-probe.views.hivemind.invalid" to true,
            "https://phone-probe.views.hivemind.invalid" to false,
            "https://other.views.hivemind.invalid" to true,
            "http://phone-probe.views.hivemind.invalid" to true,
            "https://phone-probe.views.hivemind.invalid:8443" to true,
        ).map { (origin, main) -> site.isTheView(Uri.parse(origin), main) }

        assertEquals(listOf(true, false, false, false, false), from)
    }
}

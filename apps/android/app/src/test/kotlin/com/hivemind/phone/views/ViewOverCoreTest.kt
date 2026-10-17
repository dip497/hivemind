package com.hivemind.phone.views

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.Screen
import com.hivemind.phone.core.ThemeMode
import com.hivemind.phone.core.ViewEnded
import com.hivemind.phone.core.ViewTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.time.Duration

/**
 * A view shown over the real core: the facade as scripts/phone/build-android.sh builds it for this
 * machine, telling from its own threads, as it tells the app on a phone.
 */
@RunWith(AndroidJUnit4::class)
class ViewOverCoreTest {
    @get:Rule
    val dir = TemporaryFolder()

    @Test
    fun `a view no device of the person's can show ends, told why as the core tells it, and the page goes with it`() {
        Phone.open(dir.root.path, "Priya's Pixel").use { phone ->
            // Paired with nothing: there is no device to show it.
            val relay = ViewRelay(open = { screen, told -> phone.openView(DESK, "ws-1", "phone-probe", screen, told) }, tell = {})
            var loads = 0
            relay.show(ViewRelay.Shown(load = { loads++ }, lock = { false }), Screen(390u, 844u, ViewTheme(ThemeMode.DARK, mapOf("bg" to "#141518"))))
            val until = System.nanoTime() + Duration.ofSeconds(30).toNanos()
            while (relay.ended == null && System.nanoTime() < until) {
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
                Thread.sleep(5)
            }

            assertEquals(listOf(ViewEnded.Unpaired, 1), listOf(relay.ended, loads))
        }
    }
}

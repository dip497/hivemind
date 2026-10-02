package com.hivemind.phone.views

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.core.Screen
import com.hivemind.phone.core.ThemeMode
import com.hivemind.phone.core.ViewEnded
import com.hivemind.phone.core.ViewListener
import com.hivemind.phone.core.ViewSessionInterface
import com.hivemind.phone.core.ViewTheme
import com.hivemind.phone.ui.common.Notice
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * A view's page joined to its host on the computer (design §5.5, §6.1): each load of the page meets
 * one fresh session, what the host says reaches the page in order once the page can be answered, and
 * what starts or closes something on the board waits for the phone's lock. The sessions here stand
 * for the core's, as `Phone.openView` opens them; what they tell is told from another thread's post,
 * as the core tells it, and heard on the main thread.
 */
@RunWith(AndroidJUnit4::class)
class ViewRelayTest {
    private class Session(val screen: Screen, val told: ViewListener) : ViewSessionInterface {
        val posted = mutableListOf<String>()
        val screens = mutableListOf<Screen>()
        var stopped = false

        override fun post(message: String) {
            if (!stopped) posted += message
        }

        override fun screen(screen: Screen) {
            screens += screen
        }

        override fun stop() {
            stopped = true
        }
    }

    /** A web view showing the view: the loads of its page, and the phone's lock as it is asked. */
    private class Page(var hasLock: Boolean = true) {
        var loads = 0
        val asked = mutableListOf<() -> Unit>()
        val shown = ViewRelay.Shown(load = { loads++ }, lock = { then -> hasLock.also { if (it) asked += then } })

        /** What its host said to this page, through the way back it last gave the app. */
        val heard = mutableListOf<String>()
        val reply: (String) -> Unit = { heard += it }
    }

    private val sessions = mutableListOf<Session>()
    private val notices = mutableListOf<Notice>()
    private val relay = ViewRelay(open = { screen, told -> Session(screen, told).also { sessions += it } }, tell = { notices += it })

    private fun screen(width: Int, height: Int = 800) = Screen(width.toUInt(), height.toUInt(), ViewTheme(ThemeMode.DARK, mapOf("bg" to "#141518")))

    private fun heard() = shadowOf(Looper.getMainLooper()).idle()

    private val ready = """{"type":"ready","v":1}"""
    private val select = """{"type":"command","name":"selectTile","args":["t1"]}"""
    private val start = """{"type":"command","name":"spawnAgent","args":[null,null]}"""
    private val close = """{"type":"command","name":"closeTile","args":["t1"]}"""

    @Test
    fun `shown, the view opens a session on its screen and loads its page, and restarted by the core, loads it anew in the core's session`() {
        val page = Page()

        relay.show(page.shown, screen(390))
        relay.started(page.shown)
        sessions[0].told.ended(ViewEnded.Restarting)
        heard()
        relay.started(page.shown)

        assertEquals(listOf(1, screen(390), false), listOf(sessions.size, sessions[0].screen, sessions[0].stopped))
        assertEquals(2, page.loads)
    }

    @Test
    fun `a new web view, the activity made anew or the renderer gone, gets a session of its own, the one before stopped`() {
        val before = Page()
        val after = Page()

        relay.show(before.shown, screen(390))
        relay.hide(before.shown)
        relay.show(after.shown, screen(844, 390))
        // The web view before goes after this one came: what was its own is gone already.
        relay.hide(before.shown)

        assertEquals(listOf(true, false), sessions.map { it.stopped })
        assertEquals(screen(844, 390), sessions[1].screen)
        assertEquals(listOf(1, 1), listOf(before.loads, after.loads))
    }

    @Test
    fun `a page that loads anew of its own accord gets a session of its own`() {
        val page = Page()
        relay.show(page.shown, screen(390))
        relay.started(page.shown)

        relay.started(page.shown)

        assertEquals(listOf(true, false), sessions.map { it.stopped })
    }

    @Test
    fun `what the host says waits for the page to give its way back, then goes in order, and a page loaded anew is not handed what its host said before`() {
        val page = Page()
        relay.show(page.shown, screen(390))
        val told = sessions[0].told

        told.said("""{"type":"hello"}""")
        told.said("""{"type":"structure"}""")
        heard()
        val waiting = page.heard.toList()
        relay.posted(page.shown, ready, page.reply)
        told.said("""{"type":"names"}""")
        heard()
        told.ended(ViewEnded.Restarting)
        told.said("""{"type":"hello","again":true}""")
        heard()
        val beforeReady = page.heard.toList()
        val anew = mutableListOf<String>()
        relay.posted(page.shown, ready, anew::add)

        assertEquals(emptyList<String>(), waiting)
        assertEquals(listOf("""{"type":"hello"}""", """{"type":"structure"}""", """{"type":"names"}"""), beforeReady)
        assertEquals(listOf("""{"type":"hello","again":true}"""), anew)
        assertEquals(listOf(ready, ready), sessions[0].posted)
    }

    @Test
    fun `what starts or closes something on the board is posted once the phone's lock opens, and only then`() {
        val page = Page()
        relay.show(page.shown, screen(390))
        val session = sessions[0]

        relay.posted(page.shown, select, page.reply)
        relay.posted(page.shown, start, page.reply)
        relay.posted(page.shown, close, page.reply)
        val beforeTheLock = session.posted.toList()
        // The lock opens for the start; the close is never let through.
        page.asked[0]()

        assertEquals(listOf(select), beforeTheLock)
        assertEquals(listOf(select, start), session.posted)
        assertEquals(2, page.asked.size)
        assertEquals(emptyList<Notice>(), notices)
    }

    @Test
    fun `with no lock set on the phone, what would start an agent is not posted, and the person is told to set one`() {
        val page = Page(hasLock = false)
        relay.show(page.shown, screen(390))

        relay.posted(page.shown, start, page.reply)

        assertEquals(emptyList<String>(), sessions[0].posted)
        assertEquals(listOf<Notice>(Notice.NoLock), notices)
    }

    @Test
    fun `a lock that opens once the page has loaded anew lets nothing of the page before through`() {
        val page = Page()
        relay.show(page.shown, screen(390))
        relay.posted(page.shown, start, page.reply)

        sessions[0].told.ended(ViewEnded.Restarting)
        heard()
        page.asked[0]()

        assertEquals(emptyList<String>(), sessions[0].posted)
    }

    @Test
    fun `an end is shown in place of the page, the session stopped, and the view not opened again`() {
        val ends = listOf(ViewEnded.Disabled("8 malformed or unauthorised messages"), ViewEnded.Refused("no view phone-probe here works on a phone"), ViewEnded.NotHeld, ViewEnded.Unpaired)

        val seen = ends.map { why ->
            val opened = mutableListOf<Session>()
            val relay = ViewRelay(open = { screen, told -> Session(screen, told).also { opened += it } }, tell = {})
            val page = Page()
            relay.show(page.shown, screen(390))
            opened[0].told.ended(why)
            heard()
            relay.posted(page.shown, select, page.reply)
            relay.show(Page().shown, screen(390))
            listOf(relay.ended, opened.size, opened[0].stopped, opened[0].posted)
        }

        assertEquals(ends.map { listOf(it, 1, true, emptyList<String>()) }, seen)
    }

    @Test
    fun `the session is told the screen each time it changes`() {
        val page = Page()
        relay.show(page.shown, screen(390))

        relay.screen(screen(390))
        relay.screen(screen(390, 500))
        relay.screen(screen(390, 500))
        relay.screen(Screen(390u, 500u, ViewTheme(ThemeMode.LIGHT, mapOf("bg" to "#f7f7f8"))))

        assertEquals(listOf(screen(390, 500), Screen(390u, 500u, ViewTheme(ThemeMode.LIGHT, mapOf("bg" to "#f7f7f8")))), sessions[0].screens)
    }

    @Test
    fun `what a session tells once another took its place is not heard`() {
        val before = Page()
        relay.show(before.shown, screen(390))
        relay.posted(before.shown, ready, before.reply)
        val stale = sessions[0].told
        relay.hide(before.shown)
        val after = Page()
        relay.show(after.shown, screen(390))
        relay.posted(after.shown, ready, after.reply)

        stale.said("""{"type":"names"}""")
        stale.ended(ViewEnded.Refused("gone"))
        heard()

        assertEquals(listOf(null, emptyList<String>(), emptyList<String>()), listOf(relay.ended, before.heard, after.heard))
    }
}

package com.hivemind.phone.ui.agent

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Conversation
import com.hivemind.phone.core.ConversationListener
import com.hivemind.phone.core.NoHandle
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.ScreenListener
import com.hivemind.phone.core.ScreenUpdate
import com.hivemind.phone.core.Watch
import com.hivemind.phone.line
import com.hivemind.phone.overview
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.PhoneLock
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.update
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.annotation.Config

/**
 * The agent's terminal sized to the phone (design §6.4, workspace-api 0.25): opened, the core is
 * asked to fit the session to what the screen shows at a readable size; left, to give its size back.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w400dp-h640dp-hdpi")
class TerminalFitTest {
    @get:Rule
    val compose = createComposeRule()

    /** A session the core sizes as asked: each fit is drawn at its size, a row a line. */
    private class Session : Watch(NoHandle) {
        val fits = mutableListOf<Pair<Int, Int>>()
        var unfits = 0
        lateinit var told: ScreenListener
        private var revision = 1L

        override fun fit(cols: UShort, rows: UShort) {
            fits += cols.toInt() to rows.toInt()
            told.frameReady((++revision).toULong())
        }

        override fun unfit() {
            unfits++
        }

        override fun update(since: ULong): ScreenUpdate {
            val (cols, rows) = fits.lastOrNull() ?: (200 to 50)
            return update(revision, 0, rows.toLong(), (0 until rows).map { line(it.toLong(), "row ${it + 1}") }, cols = cols, rows = rows)
        }

        override fun stop() {}
        override fun typeKeys(keys: List<String>) {}
        override fun typeText(text: String) {}
    }

    private class Talk : Conversation(NoHandle) {
        override fun stop() {}
    }

    private class Computer(val session: Session) : Phone(NoHandle) {
        override fun watch(agent: AgentRef, listener: ScreenListener): Watch = session.also { it.told = listener }

        override fun conversation(agent: AgentRef, listener: ConversationListener): Conversation {
            listener.said(emptyList(), true)
            return Talk()
        }
    }

    @Test
    fun `its terminal opened is fitted to the screen at a readable size, every row in sight, fitted again as the screen changes, and given back when left`() {
        val session = Session()
        val coder = agent("t1", hasConversation = true)
        val vm = AgentViewModel(Computer(session), MutableStateFlow(overview(agents = listOf(coder))), coder.at)
        val lock = PhoneLock(Robolectric.buildActivity(FragmentActivity::class.java).create().get())
        var screen by mutableStateOf(DpSize(400.dp, 640.dp))
        compose.setContent {
            PhoneTheme(accent = null) {
                CompositionLocalProvider(LocalPhoneLock provides lock) {
                    Box(Modifier.size(screen)) { AgentScreen(vm, onBack = {}, onDiff = {}, onClosed = {}) }
                }
            }
        }
        // On its chat, the session keeps the size it has.
        assertEquals(emptyList<Pair<Int, Int>>(), session.fits)

        compose.onNodeWithTag("agent-terminal").performClick()
        compose.waitForIdle()

        // As many columns as fit across the 400 dp screen at 12 sp: a monospace cell is 0.5 to 0.7 of its text size.
        val (cols, rows) = session.fits.single()
        assertTrue("$cols columns", cols in (400 / (12 * 0.7)).toInt()..(400 / (12 * 0.5)).toInt())
        compose.onNodeWithText("row 1").assertIsDisplayed()
        compose.onNodeWithText("row $rows").assertIsDisplayed()

        // The keyboard, a turn, another phone: each size fitted anew once it settles, every row of it in sight.
        for (size in listOf(DpSize(400.dp, 380.dp), DpSize(640.dp, 360.dp), DpSize(393.dp, 700.dp), DpSize(411.dp, 731.dp), DpSize(361.dp, 613.dp), DpSize(150.dp, 640.dp), DpSize(152.dp, 640.dp), DpSize(154.dp, 640.dp))) {
            screen = size
            compose.waitForIdle()
            compose.mainClock.advanceTimeBy(300)
            compose.waitForIdle()
            val (_, fitted) = session.fits.last()
            compose.onNodeWithText("row 1").assertIsDisplayed()
            compose.onNodeWithText("row $fitted").assertIsDisplayed()
        }

        compose.onNodeWithTag("terminal-back").performClick()
        compose.waitForIdle()

        assertEquals(1, session.unfits)
    }

    @Test
    fun `while the screen keeps changing size, as the keyboard slides, the session is not resized for each frame`() {
        val session = Session()
        val coder = agent("t1", hasConversation = true)
        val vm = AgentViewModel(Computer(session), MutableStateFlow(overview(agents = listOf(coder))), coder.at)
        val lock = PhoneLock(Robolectric.buildActivity(FragmentActivity::class.java).create().get())
        var screen by mutableStateOf(DpSize(400.dp, 640.dp))
        compose.setContent {
            PhoneTheme(accent = null) {
                CompositionLocalProvider(LocalPhoneLock provides lock) {
                    Box(Modifier.size(screen)) { AgentScreen(vm, onBack = {}, onDiff = {}, onClosed = {}) }
                }
            }
        }
        compose.onNodeWithTag("agent-terminal").performClick()
        compose.waitForIdle()
        assertEquals(1, session.fits.size)

        // A frame of the keyboard's slide every 16 ms, each a little shorter.
        compose.mainClock.autoAdvance = false
        for (height in 620 downTo 380 step 20) {
            screen = DpSize(400.dp, height.dp)
            // The clock is driven by hand: a write is seen once it is applied, as a frame would.
            Snapshot.sendApplyNotifications()
            compose.mainClock.advanceTimeBy(16)
        }
        assertEquals("fitted once when opened, and not while it slid: ${session.fits}", 1, session.fits.size)

        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(300)
        compose.waitForIdle()
        // Fitted again, and only to where it settled: none of the sizes it slid through.
        val after = session.fits.drop(1)
        assertTrue("fitted to where it settled: ${session.fits}", after.isNotEmpty())
        assertEquals("to one size only: ${session.fits}", 1, after.distinct().size)
    }
}

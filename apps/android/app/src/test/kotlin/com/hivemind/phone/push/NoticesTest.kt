package com.hivemind.phone.push

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.MINUTE
import com.hivemind.phone.agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.JoinRef
import com.hivemind.phone.core.Notice
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.device
import com.hivemind.phone.overview
import com.hivemind.phone.waiting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/** What the person is told while the app is away, as the notifications show it (P6, spec/push.md). */
@RunWith(AndroidJUnit4::class)
class NoticesTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val manager get() = shadowOf(app.getSystemService(NotificationManager::class.java))
    private val notices = Notices(app)

    private val nav = AgentRef(DESK, "ws-1", "t1")
    private val since = 5 * MINUTE

    private fun waits(kind: WaitKind, decide: Boolean, at: AgentRef = nav) =
        Notice.Waits(at, "Editing Nav.tsx", "hivemind", kind, since.toULong(), decide)

    private fun shown(tag: String, id: Int): Notification = manager.getNotification(tag, id) ?: throw AssertionError("nothing shown as $tag")

    private fun isShown(tag: String, id: Int) = manager.getNotification(tag, id) != null

    private val Notification.opens get() = openedOn(shadowOf(contentIntent).savedIntent)

    private val Notification.buttons get() = actions.orEmpty().map { it.title.toString() }

    @Before
    fun allow() = shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    @Test
    fun `a wait its device can decide has Allow and Deny, any other none, and each opens its agent`() {
        val plan = AgentRef(DESK, "ws-1", "t2")
        notices.show(waits(WaitKind.PERMISSION, decide = true))
        notices.show(waits(WaitKind.PLAN, decide = false, at = plan))

        val permission = shown("ws-1/t1/$since", Notices.WAITS)
        assertEquals(Notices.CHANNEL_NEEDS, permission.channelId)
        assertEquals(listOf("Allow", "Deny"), permission.buttons)
        assertEquals(nav, permission.opens)

        val planned = shown("ws-1/t2/$since", Notices.WAITS)
        assertEquals(Notices.CHANNEL_NEEDS, planned.channelId)
        assertEquals(emptyList<String>(), planned.buttons)
        assertEquals(plan, planned.opens)
    }

    @Test
    fun `the same wait told by two devices shows once`() {
        notices.show(waits(WaitKind.PERMISSION, decide = true))
        notices.show(waits(WaitKind.PERMISSION, decide = true))

        assertEquals(1, manager.allNotifications.size)
    }

    @Test
    fun `an agent finished or failed is told in its own channel, a device back in another`() {
        notices.show(Notice.Finished(nav, "Editing Nav.tsx", "hivemind", 7uL))
        notices.show(Notice.Failed(AgentRef(DESK, "ws-1", "t2"), "Tests", "hivemind", 8uL))
        notices.show(Notice.Back("laptop-id", "laptop", 9uL))

        val finished = shown("ws-1/t1/7", Notices.FINISHED)
        assertEquals(Notices.CHANNEL_ENDED, finished.channelId)
        assertEquals(nav, finished.opens)
        assertEquals(Notices.CHANNEL_ENDED, shown("ws-1/t2/8", Notices.FAILED).channelId)
        assertEquals(Notices.CHANNEL_BACK, shown("back/laptop-id", Notices.BACK).channelId)
    }

    @Test
    fun `a wait goes once its device, having said since what waits there, no longer lists it, and stays until it has`() {
        notices.show(waits(WaitKind.PERMISSION, decide = true))
        val posted = manager.activeNotifications.single().postTime
        val listed = agent("t1", state = AgentState.WAITING, waiting = waiting(WaitKind.PERMISSION, since = since))

        // What the core kept from before the notice: it says nothing of a newer wait.
        notices.cleared(overview(devices = listOf(device(DESK, "desk", heardAt = posted - 1))))
        assertTrue(isShown("ws-1/t1/$since", Notices.WAITS))

        // Reached since, it told the workspaces it holds, and not yet what waits there.
        notices.cleared(overview(devices = listOf(device(DESK, "desk", heardAt = posted + 1, answeredAt = posted - 1))))
        assertTrue(isShown("ws-1/t1/$since", Notices.WAITS))

        // Heard since, still waiting.
        notices.cleared(overview(needs = listOf(listed), devices = listOf(device(DESK, "desk", heardAt = posted + 1))))
        assertTrue(isShown("ws-1/t1/$since", Notices.WAITS))

        // Heard since, and answered.
        notices.cleared(overview(devices = listOf(device(DESK, "desk", heardAt = posted + 2))))
        assertFalse(isShown("ws-1/t1/$since", Notices.WAITS))
    }

    @Test
    fun `someone asking to join is told by name and workspace, what their link lets them do, with Allow and Deny`() {
        notices.show(Notice.Join(JoinRef(DESK, "ws-1", 3uL), "Priya", "hivemind", "terminals", 9uL))
        notices.show(Notice.Join(JoinRef(DESK, "ws-1", 4uL), "", "hivemind", "view", 9uL))

        val asked = shown("join/ws-1/3", Notices.JOIN)
        assertEquals(Notices.CHANNEL_NEEDS, asked.channelId)
        assertEquals("Priya asks to join hivemind", asked.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Their link lets them use terminals", asked.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(listOf("Allow", "Deny"), asked.buttons)
        assertEquals("Someone asks to join hivemind", shown("join/ws-1/4", Notices.JOIN).extras.getCharSequence(Notification.EXTRA_TITLE).toString())
    }
}

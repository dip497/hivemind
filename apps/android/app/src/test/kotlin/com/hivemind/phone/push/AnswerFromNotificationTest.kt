package com.hivemind.phone.push

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.MINUTE
import com.hivemind.phone.PhoneApp
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Decision
import com.hivemind.phone.core.Notice
import com.hivemind.phone.core.WaitKind
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Allow or Deny on a wait's notification, answered with the app left closed (P6, spec/needs.md
 * "Answering"), and what the notification then says.
 */
@RunWith(AndroidJUnit4::class)
@Config(application = PhoneApp::class)
class AnswerFromNotificationTest {
    private val app = ApplicationProvider.getApplicationContext<PhoneApp>()
    private val core = (app.core as PhoneApp.Opened.Ready).core
    private val manager get() = shadowOf(app.getSystemService(NotificationManager::class.java))

    private val notice = Notice.Waits(AgentRef(DESK, "ws-1", "t1"), "Editing Nav.tsx", "hivemind", WaitKind.PERMISSION, (5 * MINUTE).toULong(), true)
    private val wait = Wait.of(notice)

    private val shown: Notification get() = manager.getNotification(wait.tag, Notices.WAITS) ?: throw AssertionError("not shown")
    private val Notification.said get() = extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString()
    private val Notification.buttons get() = actions.orEmpty().map { it.title.toString() }

    @Before
    fun shownFirst() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        core.notices.show(notice)
    }

    @Test
    fun `an answer that lands says so, and Allow and Deny go`() = runBlocking {
        core.notices.answer(wait, Decision.DENY) { true }

        assertEquals("Denied", shown.said)
        assertEquals(emptyList<String>(), shown.buttons)
    }

    @Test
    fun `a wait answered already says so`() = runBlocking {
        core.notices.answer(wait, Decision.ALLOW) { false }

        assertEquals("Already answered", shown.said)
        assertEquals(emptyList<String>(), shown.buttons)
    }

    @Test
    fun `Allow tapped says so at once, then, answered over the real core, why it did not go, with Allow and Deny to try again`() {
        // The phone is paired with nothing: the core cannot answer, and says why.
        val allow = shadowOf(shown.actions.first { it.title == "Allow" }.actionIntent).savedIntent
        AnswerReceiver().onReceive(app, allow)
        assertEquals("Allowing…", shown.said)
        assertEquals(emptyList<String>(), shown.buttons)

        // WorkManager runs the answer on its own threads.
        val until = System.nanoTime() + 30_000_000_000
        while (shown.said == "Allowing…" && System.nanoTime() < until) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(20)
        }
        assertTrue(shown.said, shown.said.startsWith("Not answered: ") && shown.said.length > "Not answered: ".length)
        assertEquals(listOf("Allow", "Deny"), shown.buttons)
    }
}

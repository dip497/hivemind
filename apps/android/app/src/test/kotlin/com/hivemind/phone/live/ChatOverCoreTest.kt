package com.hivemind.phone.live

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.Phone
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.time.Duration

/**
 * A conversation followed over the real core: the facade as scripts/phone/build-android.sh builds
 * it for this machine, telling from its own threads, as it tells the app on a phone.
 */
@RunWith(AndroidJUnit4::class)
class ChatOverCoreTest {
    @get:Rule
    val dir = TemporaryFolder()

    @Test
    fun `a conversation the core cannot follow ends, told why as the core tells it`() {
        Phone.open(dir.root.path, "Priya's Pixel").use { phone ->
            // Paired with nothing: there is no device to ask.
            val feed = ChatFeed(phone, AgentRef(DESK, "ws-1", "t1"))
            val until = System.nanoTime() + Duration.ofSeconds(30).toNanos()
            while (feed.chat.ended == null && System.nanoTime() < until) {
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(16))
                Thread.sleep(5)
            }
            feed.stop()

            assertEquals(ConversationEnded.Unpaired, feed.chat.ended)
        }
    }
}

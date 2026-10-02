package com.hivemind.phone.live

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.time.Duration
import kotlin.concurrent.thread

/** The core's news, from its own threads, pulled once a frame on the main thread (design §3.4). */
@RunWith(AndroidJUnit4::class)
class FramePullTest {
    private fun nextFrames() = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))

    @Test
    fun `changes told from a core thread between two frames are pulled once, on the main thread`() {
        val pulledOn = mutableListOf<Looper?>()
        val pull = FramePull { pulledOn += Looper.myLooper() }

        thread { repeat(100) { pull.request() } }.join()
        nextFrames()
        assertEquals(listOf(Looper.getMainLooper()), pulledOn)

        // The next change gets a frame of its own.
        thread { pull.request() }.join()
        nextFrames()
        assertEquals(2, pulledOn.size)
    }

    @Test
    fun `once stopped, it pulls nothing more, a frame already asked for included`() {
        var pulls = 0
        val pull = FramePull { pulls++ }

        pull.request()
        pull.stop()
        thread { pull.request() }.join()
        nextFrames()

        assertEquals(0, pulls)
    }
}

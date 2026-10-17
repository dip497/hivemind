package com.hivemind.phone.live

import android.view.Choreographer
import androidx.compose.runtime.snapshots.Snapshot
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Folds the core's news, told from its own threads, into one pull on the main thread a frame
 * (design §3.4): however many changes come between two frames, one Choreographer callback waits,
 * and it pulls the newest once.
 *
 * Made on the main thread: its Choreographer runs the callback there, whichever thread posts it,
 * so the hop to the main thread and the coalescing are one step.
 */
class FramePull(private val pull: () -> Unit) : Choreographer.FrameCallback {
    private val choreographer = Choreographer.getInstance()
    private val waiting = AtomicBoolean(false)

    @Volatile
    private var stopped = false

    /** Something changed: pull on the next frame. From any thread. */
    fun request() {
        if (!stopped && waiting.compareAndSet(false, true)) choreographer.postFrameCallback(this)
    }

    override fun doFrame(frameTimeNanos: Long) {
        // Cleared before the pull: a change told while it runs gets a frame of its own.
        waiting.set(false)
        if (stopped) return
        pull()
        // Hand what the pull wrote to Compose now, so it is drawn in this frame rather than the next.
        Snapshot.sendApplyNotifications()
    }

    /** Pull no more: what comes after is dropped. Main thread. */
    fun stop() {
        stopped = true
        choreographer.removeFrameCallback(this)
    }
}

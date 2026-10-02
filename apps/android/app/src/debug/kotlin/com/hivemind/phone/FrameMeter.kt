package com.hivemind.phone

import android.app.Activity
import android.util.Log
import androidx.metrics.performance.JankStats

/**
 * A debug build counts its frames (design §3.8): for each second the screen draws, how many frames
 * it drew and how many ran over their budget, logged under `hivemind.frames`
 * (`adb logcat -s hivemind.frames`). Release builds count nothing.
 */
class FrameMeter(activity: Activity) {
    private var frames = 0
    private var overBudget = 0
    private var second = 0L

    // Tracks frames for as long as the window lives.
    private val stats = JankStats.createAndTrack(activity.window) { frame ->
        if (second == 0L) second = frame.frameStartNanos
        frames++
        if (frame.isJank) overBudget++
        if (frame.frameStartNanos - second >= 1_000_000_000L) {
            Log.d(TAG, "$frames frames, $overBudget over budget")
            frames = 0
            overBudget = 0
            second = frame.frameStartNanos
        }
    }

    private companion object {
        const val TAG = "hivemind.frames"
    }
}

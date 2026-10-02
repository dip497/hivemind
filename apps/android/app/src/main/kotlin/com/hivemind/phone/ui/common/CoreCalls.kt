package com.hivemind.phone.ui.common

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.PhoneException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** What a screen tells the person once, after something they did: what the core answered. */
sealed interface Notice {
    /** The core's own words for why it could not (design §5.1: not paired, unreachable, refused…). */
    data class Failed(val message: String) : Notice

    /** An answer that came after the wait was over, or after someone else answered it. */
    data object AlreadyAnswered : Notice

    /** A message for an agent that no longer runs. */
    data object NotRunning : Notice

    /** A stop for an agent that was not in a turn. */
    data object NotStopped : Notice

    /** A close for an agent already gone. */
    data object AlreadyClosed : Notice

    /** This phone forgot the device, which was not told: it still lists the phone until unpaired there. */
    data class NotTold(val device: String) : Notice

    /** Starting or closing an agent asks the phone's lock, and this phone has none set. */
    data object NoLock : Notice
}

/**
 * A screen's calls to the core: one at a time for each thing they act on (an agent, a device),
 * whose buttons wait meanwhile, and each failure told to the person once, in the core's words.
 */
class CoreCalls(private val scope: CoroutineScope) {
    /** What a call is in flight for. */
    var busy: Set<Any> by mutableStateOf(emptySet())
        private set

    /** What to tell the person, until [seen]. */
    var notice: Notice? by mutableStateOf(null)
        private set

    /** Calls the core for [target], unless a call for it is in flight, and hands [done] its answer. */
    fun <T> launch(target: Any, call: suspend () -> T, done: (T) -> Unit = {}) {
        if (target in busy) return
        busy = busy + target
        scope.launch {
            try {
                done(call())
            } catch (e: PhoneException) {
                notice = Notice.Failed(e.message.orEmpty())
            } finally {
                busy = busy - target
            }
        }
    }

    fun tell(notice: Notice) {
        this.notice = notice
    }

    fun seen() {
        notice = null
    }
}

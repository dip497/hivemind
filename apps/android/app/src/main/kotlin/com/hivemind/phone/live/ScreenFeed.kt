package com.hivemind.phone.live

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.ScreenEnded
import com.hivemind.phone.core.ScreenListener
import com.hivemind.phone.core.Watch
import com.hivemind.phone.terminal.Terminal

/**
 * One agent's terminal, watched (design §5.3). The core tells of a new frame from its own thread,
 * at most one per 16 ms; the terminal pulls what changed since the revision it last drew, in one
 * call, once on the main thread's next frame, however many frames came meanwhile. When the core
 * resumes the watch after the app was away, it starts from a fresh screen, which the update that
 * follows carries whole.
 *
 * Made on the main thread; [stop] it when the screen showing it goes.
 */
class ScreenFeed(phone: Phone, agent: AgentRef) {
    /** The terminal as drawn. */
    val terminal = Terminal()

    /** Who holds the session's keyboard; null while the person's own devices do. */
    var keyboard: String? by mutableStateOf(null)
        private set

    /** How the watch ended, once it has. */
    var ended: ScreenEnded? by mutableStateOf(null)
        private set

    private val main = Handler(Looper.getMainLooper())

    // Before watching: the core may tell of a frame as soon as the watch begins.
    private val pull = FramePull { terminal.apply(watch.update(terminal.revision)) }

    // What the core tells, from its threads: kept apart from what the screen calls.
    private val told = object : ScreenListener {
        override fun frameReady(revision: ULong) = pull.request()

        override fun keyboard(holder: String?) {
            main.post { keyboard = holder }
        }

        override fun ended(why: ScreenEnded) {
            main.post { ended = why }
        }
    }

    private val watch: Watch = phone.watch(agent, told)

    init {
        // What the core has already, drawn at once rather than at its next frame.
        pull.request()
    }

    /** Types [text] into the session as it is, as the person. */
    fun typeText(text: String) = watch.typeText(text)

    /** Presses [keys], tokens as `hive ctl keys` takes them: `enter`, `escape`, `ctrl-c`, … */
    fun typeKeys(keys: List<String>) = watch.typeKeys(keys)

    fun stop() {
        pull.stop()
        watch.stop()
        watch.destroy()
    }
}

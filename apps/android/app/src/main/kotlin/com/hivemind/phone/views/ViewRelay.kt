package com.hivemind.phone.views

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.Screen
import com.hivemind.phone.core.ViewEnded
import com.hivemind.phone.core.ViewListener
import com.hivemind.phone.core.ViewSessionInterface
import com.hivemind.phone.core.viewAsksLock
import com.hivemind.phone.ui.common.Notice

/**
 * One community view shown on the phone (design §5.5, §6.1): between the page in the web view that
 * shows it and its host on the computer, through the core.
 *
 * Each load of the page meets one fresh session there, as the host refuses a second `ready` in one:
 * a web view that shows the view opens one ([show]) and loads the page; when the core says the view
 * restarts (the connection to the computer went and came back, and the core opened a session there
 * again), the page is loaded anew in that session; a page that loads anew of its own accord is given
 * a session of its own ([started]); and a web view that goes (the screen left, the activity made
 * anew, its renderer gone) takes its session with it ([hide]).
 *
 * What the page posts goes to its host at once, but for what starts or closes something on the
 * board, which is posted only once the phone's lock opens (design §4); with no lock set, the person
 * is told to set one ([tell]). What its host says goes to the page in order, once the page has given
 * the app its way back (its first post, the view SDK's `ready`); until then it waits.
 *
 * [open] opens the view's session on a screen, told to a listener. Main thread.
 */
class ViewRelay(
    private val open: (Screen, ViewListener) -> ViewSessionInterface,
    private val tell: (Notice) -> Unit,
) {
    /** A web view showing the view: [load] loads its page anew; [lock] asks the phone's lock and
     *  calls its argument once it opens, false (asking nothing) when the phone has no lock set. */
    class Shown(val load: () -> Unit, val lock: (then: () -> Unit) -> Boolean)

    /** Why the view is shown no more, once it is not: in place of the page. Never `Restarting`. */
    var ended: ViewEnded? by mutableStateOf(null)
        private set

    private val main = Handler(Looper.getMainLooper())
    private var shown: Shown? = null
    private var screen: Screen? = null
    private var session: ViewSessionInterface? = null

    /** Who hears the session now: what an earlier one told, still on its way, is not heard. */
    private var told: Told? = null

    /** The session waits for a page that has not started loading yet: the one [show] or a restart loads. */
    private var fresh = false

    /** The pages loaded so far: a post the lock lets through once another page loaded is dropped. */
    private var loads = 0

    /** Hands the page in the web view what its host says; none until the page has posted. */
    private var reply: ((String) -> Unit)? = null
    private val held = ArrayDeque<String>()

    /** [shown] shows the view now, on [screen]: a session is opened for it, and its page loaded. */
    fun show(shown: Shown, screen: Screen) {
        stop()
        if (ended != null) return
        this.shown = shown
        this.screen = screen
        begin()
        shown.load()
    }

    /** A page began loading in [shown]: the one asked for, or one the page loaded of its accord. */
    fun started(shown: Shown) {
        if (shown !== this.shown || session == null) return
        if (fresh) {
            fresh = false
            return
        }
        end()
        begin()
        fresh = false
    }

    /** [shown] shows the view no more: its session ends. */
    fun hide(shown: Shown) {
        if (shown === this.shown) stop()
    }

    /** The web view is on [screen] now: its size, or its look, changed. */
    fun screen(screen: Screen) {
        if (screen == this.screen) return
        this.screen = screen
        session?.screen(screen)
    }

    /** The page in [shown] posted [message]; [reply] hands it what its host says. */
    fun posted(shown: Shown, message: String, reply: (String) -> Unit) {
        if (shown !== this.shown) return
        val session = session ?: return
        this.reply = reply
        while (held.isNotEmpty()) reply(held.removeFirst())
        if (!viewAsksLock(message)) {
            session.post(message)
            return
        }
        val page = loads
        val asked = shown.lock {
            if (this.session === session && loads == page) session.post(message)
        }
        if (!asked) tell(Notice.NoLock)
    }

    /** Shown no more anywhere: the screen is left. */
    fun stop() {
        shown = null
        end()
    }

    private fun begin() {
        val told = Told()
        this.told = told
        session = open(screen!!, told)
        fresh = true
        loads++
    }

    private fun end() {
        told = null
        reply = null
        held.clear()
        session?.let {
            it.stop()
            (it as? AutoCloseable)?.close()
        }
        session = null
    }

    private fun say(message: String) {
        val page = reply
        if (page == null) held.addLast(message) else page(message)
    }

    private fun heard(why: ViewEnded) {
        if (why is ViewEnded.Restarting) {
            // The core's session is new, and waits for the page loaded anew; what the page of before
            // posts meanwhile, the core drops.
            reply = null
            held.clear()
            fresh = true
            loads++
            shown?.load()
        } else {
            ended = why
            stop()
        }
    }

    /** What the session tells, from a thread of the core's: heard on the main thread, in order. */
    private inner class Told : ViewListener {
        override fun said(message: String) {
            main.post { if (told === this) this@ViewRelay.say(message) }
        }

        override fun ended(why: ViewEnded) {
            main.post { if (told === this) heard(why) }
        }
    }
}

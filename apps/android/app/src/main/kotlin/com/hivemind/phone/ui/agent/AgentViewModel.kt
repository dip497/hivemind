package com.hivemind.phone.ui.agent

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.live.ChatFeed
import com.hivemind.phone.live.ScreenFeed
import com.hivemind.phone.ui.common.CoreCalls
import com.hivemind.phone.ui.common.Notice
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** What typing turned the box from one text into another: characters erased off its end, then text added. */
data class Typing(val erase: Int, val text: String)

/**
 * The keys that turn [before] into [after] at the terminal's prompt: a backspace for each character
 * taken off the end (what an autocorrect rewrote among them), then what was added.
 */
fun typing(before: String, after: String): Typing {
    val kept = before.commonPrefixWith(after).length
    return Typing(erase = before.codePointCount(kept, before.length), text = after.substring(kept))
}

/**
 * One agent (design §6.4): its live terminal, what it and the person say to each other (P7), what
 * it waits on, and what the person can do to it.
 */
class AgentViewModel(private val phone: Phone, overview: StateFlow<Overview>, val ref: AgentRef) : ViewModel() {
    val agent: StateFlow<Agent?> = overview.map { it.agents.firstOrNull { agent -> agent.at == ref } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, overview.value.agents.firstOrNull { it.at == ref })

    /** The terminal, watched for as long as this screen is in the back stack. */
    val screen = ScreenFeed(phone, ref)

    private val talk = lazy { ChatFeed(phone, ref) }

    /** What it and the person say to each other: followed from when it is first shown, for as long as this screen is in the back stack. */
    val chat: ChatFeed by talk

    val calls = CoreCalls(viewModelScope)

    /** What the Type box holds: typed into the terminal as it changes, emptied by Enter. */
    var typed by mutableStateOf("")
        private set

    /** A message for the agent: typed as its next prompt once it is at its prompt (spec/needs.md "Sending"). */
    fun send(text: String) = calls.launch(Call.SEND, { phone.send(ref, text) }) { sent ->
        if (!sent) calls.tell(Notice.NotRunning)
    }

    fun answer(answer: Answer) {
        val since = agent.value?.waiting?.since ?: return
        calls.launch(Call.ANSWER, { phone.answer(ref, since, answer) }) { answered ->
            if (!answered) calls.tell(Notice.AlreadyAnswered)
        }
    }

    fun stop() = calls.launch(Call.STOP, { phone.interrupt(ref) }) { stopped ->
        if (!stopped) calls.tell(Notice.NotStopped)
    }

    /** Closes the agent, and calls [closed] once it is; the phone's lock is asked first. */
    fun close(closed: () -> Unit) = calls.launch(Call.CLOSE, { phone.closeAgent(ref) }) { done ->
        if (done) closed() else calls.tell(Notice.AlreadyClosed)
    }

    /** The Type box now holds [next]: what changed is typed into the terminal, as the person. */
    fun type(next: String) {
        val change = typing(typed, next)
        typed = next
        if (change.erase > 0) screen.typeKeys(List(change.erase) { "backspace" })
        if (change.text.isNotEmpty()) screen.typeText(change.text)
    }

    /** Presses one key: `escape`, `tab`, `up`, `down`, `left`, `right`, `enter`, `ctrl-c`. */
    fun press(key: String) {
        screen.typeKeys(listOf(key))
        // A line entered or abandoned: the box starts afresh, as the prompt does.
        if (key == "enter" || key == "ctrl-c") typed = ""
    }

    override fun onCleared() {
        screen.stop()
        if (talk.isInitialized()) chat.stop()
    }

    private enum class Call { SEND, ANSWER, STOP, CLOSE }
}

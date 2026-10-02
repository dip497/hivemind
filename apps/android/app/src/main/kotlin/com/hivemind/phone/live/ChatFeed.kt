package com.hivemind.phone.live

import com.hivemind.phone.chat.Chat
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.ConversationListener
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.Phone
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * What an agent and the person say to each other, followed (design P7). The core tells it from
 * its own threads, at most once every 16 ms; what it tells waits for the main thread's next frame,
 * and is drawn then, all of it at once.
 *
 * Made on the main thread; [stop] it when the screen showing it goes.
 */
class ChatFeed(phone: Phone, agent: AgentRef) {
    val chat = Chat()

    private sealed interface Told {
        class Said(val entries: List<Entry>, val anew: Boolean) : Told

        class Ended(val why: ConversationEnded) : Told
    }

    private val told = ConcurrentLinkedQueue<Told>()

    // Before following: the core may tell as soon as it is followed.
    private val pull = FramePull {
        while (true) {
            when (val next = told.poll() ?: break) {
                is Told.Said -> chat.said(next.entries, next.anew)
                is Told.Ended -> chat.end(next.why)
            }
        }
    }

    private val listener = object : ConversationListener {
        override fun said(entries: List<Entry>, anew: Boolean) {
            told += Told.Said(entries, anew)
            pull.request()
        }

        override fun ended(why: ConversationEnded) {
            told += Told.Ended(why)
            pull.request()
        }
    }

    private val conversation = phone.conversation(agent, listener)

    fun stop() {
        pull.stop()
        conversation.stop()
        conversation.destroy()
    }
}

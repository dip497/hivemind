package com.hivemind.phone.chat

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.ToolResult
import com.hivemind.phone.ui.common.Follow

/**
 * What an agent and the person said to each other, as the phone shows it (design P7): every entry
 * in the order said, each tool's result folded under the use it answers, and the list following
 * the newest entry. It changes only as the core tells it, once a frame.
 */
@Stable
class Chat {
    private val shown = mutableStateListOf<Entry>()

    /** What is shown, oldest first: every entry but the results folded under their uses. */
    val entries: List<Entry> get() = shown

    /** Whether the core has told anything yet: until it has, that nothing is shown says nothing. */
    var heard by mutableStateOf(false)
        private set

    /** Why the conversation is told no more, once it is. */
    var ended: ConversationEnded? by mutableStateOf(null)
        private set

    val follow = Follow()

    private val results = mutableStateMapOf<String, ToolResult>()

    // The entries shown and the tools used, by id: each entry is shown once, as the list keys it.
    private val ids = HashSet<String>()
    private val uses = HashSet<String>()

    /** What a use of a tool gave back, by the use's id; none yet. */
    fun result(use: String): ToolResult? = results[use]

    /** [said] after what was told before, or [anew], in place of it all (another session began). */
    fun said(said: List<Entry>, anew: Boolean) {
        heard = true
        if (anew) {
            shown.clear()
            results.clear()
            ids.clear()
            uses.clear()
            // What the person had scrolled back to is gone.
            follow.on = true
        }
        val added = ArrayList<Entry>(said.size)
        for (entry in said) {
            if (!ids.add(entry.id)) continue
            val result = entry.result
            if (result != null && result.of in uses) {
                results[result.of] = result
                continue
            }
            entry.tool?.let { uses += it.id }
            added += entry
        }
        shown.addAll(added)
        follow.grew(last)
    }

    fun end(why: ConversationEnded) {
        heard = true
        ended = why
        follow.grew(last)
    }

    /** The newest item of the list drawn: the note saying why it ended, once it has. */
    val last: Int get() = shown.size - 1 + if (ended != null) 1 else 0
}

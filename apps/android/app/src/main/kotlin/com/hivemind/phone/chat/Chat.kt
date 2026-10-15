package com.hivemind.phone.chat

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.Said
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

    /** The list, drawn from the bottom up: its first item is the newest. */
    val follow = Follow(newestFirst = true)

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
            when (val what = entry.said) {
                is Said.ToolOutput -> if (what.result.of in uses) {
                    results[what.result.of] = what.result
                    continue
                }
                is Said.ToolUse -> uses += what.tool.id
                is Said.Person, is Said.Agent -> {}
            }
            added += entry
        }
        shown.addAll(added)
        follow.grew(0)
    }

    fun end(why: ConversationEnded) {
        heard = true
        ended = why
        follow.grew(0)
    }

    /** The use of a tool that [entry] shows, as its own screen shows it; none when no such entry is shown. */
    fun toolCall(entry: String): ToolCall? = when (val said = shown.firstOrNull { it.id == entry }?.said) {
        is Said.ToolUse -> ToolCall(said.tool.name, said.tool.about, results[said.tool.id])
        is Said.ToolOutput -> ToolCall(null, null, said.result)
        else -> null
    }
}

/** A use of a tool: the tool's name (none for a result whose use was told before what is shown began), what the use is about, and what it gave back, once it has. */
data class ToolCall(val name: String?, val about: String?, val result: ToolResult?)

package com.hivemind.phone.chat

import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.Said
import com.hivemind.phone.core.TextBlock
import com.hivemind.phone.core.ToolResult
import com.hivemind.phone.ui.common.Follow

/**
 * What an agent and the person said to each other, as the phone shows it (design P7): every entry
 * in the order said, each tool's result folded under the use it answers, and the list following
 * the newest entry. It changes only as the core tells it, once a frame.
 */
@Stable
class Chat {
    private val told = mutableStateListOf<Entry>()

    /** What is shown, oldest first: every entry but the results folded under their uses. */
    val entries: List<Entry> get() = told

    /** What the list draws, oldest first: each entry, but every run of two or more tools used one
     *  after another in one fold (design PB §12.12). */
    val shown: List<Shown> by derivedStateOf { shownOf(told) }

    /** The folds the person opened, by their key. */
    val opened = mutableStateMapOf<String, Boolean>()

    /** Whether the core has told anything yet: until it has, that nothing is shown says nothing. */
    var heard by mutableStateOf(false)
        private set

    /** Why the conversation is told no more, once it is. */
    var ended: ConversationEnded? by mutableStateOf(null)
        private set

    /** The list, drawn from the bottom up: its first item is the newest. */
    val follow = Follow(newestFirst = true)

    // Each use's result a state of its own: one that comes redraws the row that shows it, not every tool row in sight.
    private val results = HashMap<String, MutableState<ToolResult?>>()

    // What the agent said, as markdown read off the main thread, by its entry's id.
    private val parsed = HashMap<String, List<TextBlock>>()

    /** What the agent said in [entry], read as markdown before it came to the main thread; none, read when drawn. */
    fun blocks(entry: String): List<TextBlock>? = parsed[entry]

    // The entries shown and the tools used, by id: each entry is shown once, as the list keys it.
    private val ids = HashSet<String>()
    private val uses = HashSet<String>()

    /** What a use of a tool gave back, by the use's id; none yet. */
    fun result(use: String): ToolResult? = results[use]?.value

    /** [said] after what was told before, or [anew], in place of it all (another session began); [read], what the agent said read as markdown, by entry. */
    fun said(said: List<Entry>, anew: Boolean, read: Map<String, List<TextBlock>> = emptyMap()) {
        heard = true
        if (anew) {
            told.clear()
            results.clear()
            ids.clear()
            uses.clear()
            opened.clear()
            parsed.clear()
            // What the person had scrolled back to is gone.
            follow.on = true
        }
        val added = ArrayList<Entry>(said.size)
        for (entry in said) {
            if (!ids.add(entry.id)) continue
            when (val what = entry.said) {
                is Said.ToolOutput -> if (what.result.of in uses) {
                    results.getOrPut(what.result.of) { mutableStateOf(null) }.value = what.result
                    continue
                }
                is Said.ToolUse -> if (uses.add(what.tool.id)) results.getOrPut(what.tool.id) { mutableStateOf(null) }
                is Said.Person, is Said.Agent -> {}
            }
            added += entry
        }
        read.forEach { (id, blocks) -> if (id in ids) parsed[id] = blocks }
        told.addAll(added)
        // Only what was added moves the list: a result folded under its use redraws its row alone.
        if (anew || added.isNotEmpty()) follow.grew(0)
    }

    fun end(why: ConversationEnded) {
        heard = true
        ended = why
        follow.grew(0)
    }

    /** The use of a tool that [entry] shows, as its own screen shows it; none when no such entry is shown. */
    fun toolCall(entry: String): ToolCall? = when (val said = told.firstOrNull { it.id == entry }?.said) {
        is Said.ToolUse -> ToolCall(said.tool.name, said.tool.about, results[said.tool.id])
        is Said.ToolOutput -> ToolCall(null, null, said.result)
        else -> null
    }
}

/** A use of a tool: the tool's name (none for a result whose use was told before what is shown began), what the use is about, and what it gave back, once it has. */
data class ToolCall(val name: String?, val about: String?, val result: ToolResult?)

/** One thing the chat draws: an entry, or tools used one after another, folded into one row. */
sealed interface Shown {
    /** Its key in the list: a fold's is its first tool's, so it stays the fold as more join it. */
    val key: String

    data class One(val entry: Entry) : Shown {
        override val key: String get() = entry.id
    }

    data class Tools(val entries: List<Entry>) : Shown {
        override val key: String get() = "tools:${entries.first().id}"
    }
}

private val Entry.isTool get() = said is Said.ToolUse || said is Said.ToolOutput

/** [entries], each run of two or more tools in one [Shown.Tools]; one alone stays its own row. */
fun shownOf(entries: List<Entry>): List<Shown> {
    val out = ArrayList<Shown>(entries.size)
    var i = 0
    while (i < entries.size) {
        if (!entries[i].isTool) {
            out += Shown.One(entries[i++])
            continue
        }
        val from = i
        while (i < entries.size && entries[i].isTool) i++
        out += if (i - from == 1) Shown.One(entries[from]) else Shown.Tools(entries.subList(from, i).toList())
    }
    return out
}

/** What a tool's row and its fold call it: a command is run. */
private val Verbs = mapOf("Bash" to "Run", "shell" to "Run", "exec_command" to "Run", "local_shell" to "Run")

fun verb(name: String): String = Verbs[name] ?: name

/** A fold's row: how many of each tool, in the order first used ("Read 3 · Edit 2"), and how many failed. */
data class ToolsSummary(val counts: String, val failed: Int)

/** [orphan] names a result whose use was told before what is shown began. */
fun Chat.summary(tools: List<Entry>, orphan: String): ToolsSummary {
    val counts = LinkedHashMap<String, Int>()
    var failed = 0
    for (entry in tools) {
        val (name, gave) = when (val said = entry.said) {
            is Said.ToolUse -> verb(said.tool.name) to result(said.tool.id)
            is Said.ToolOutput -> orphan to said.result
            else -> continue
        }
        counts[name] = (counts[name] ?: 0) + 1
        if (gave?.error == true) failed++
    }
    return ToolsSummary(counts.entries.joinToString(" · ") { "${it.key} ${it.value}" }, failed)
}

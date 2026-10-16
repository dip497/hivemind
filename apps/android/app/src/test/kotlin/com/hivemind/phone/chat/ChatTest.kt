package com.hivemind.phone.chat

import com.hivemind.phone.agentSaid
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.person
import com.hivemind.phone.toolResult
import com.hivemind.phone.toolUse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What an agent and the person said, as the chat keeps it from what the core tells (design §5.4). */
class ChatTest {
    private fun Chat.ids() = entries.map { it.id }

    @Test
    fun `a tool's result folds under the use it answers, and one whose use is not shown stands alone`() {
        val chat = Chat()
        chat.said(listOf(person("e1", "Fix the nav"), toolUse("e2", use = "u1", name = "Edit", about = "src/nav.ts")), anew = true)
        chat.said(listOf(toolResult("e3", use = "u1", text = "done"), toolResult("e4", use = "u0", text = "from before")), anew = false)

        assertEquals(listOf("e1", "e2", "e4"), chat.ids())
        assertEquals("done", chat.result("u1")?.text)
        assertNull(chat.result("u0"))
    }

    @Test
    fun `told anew, it shows the new session alone, and follows it again`() {
        val chat = Chat()
        chat.said(listOf(person("e1", "Fix the nav"), toolUse("e2", use = "u1", name = "Edit")), anew = true)
        chat.follow.on = false

        chat.said(listOf(agentSaid("e9", "Cleared."), toolResult("e10", use = "u1", text = "done")), anew = true)

        // The old session's use went with it: its result stands alone.
        assertEquals(listOf("e9", "e10"), chat.ids())
        assertNull(chat.result("u1"))
        assertTrue(chat.follow.on)
    }

    @Test
    fun `an entry told twice is shown once`() {
        val chat = Chat()
        chat.said(listOf(person("e1", "Fix the nav")), anew = true)
        chat.said(listOf(person("e1", "Fix the nav"), agentSaid("e2", "On it.")), anew = false)

        assertEquals(listOf("e1", "e2"), chat.ids())
    }

    @Test
    fun `why it ended is heard though nothing was said`() {
        val ended = Chat()
        ended.end(ConversationEnded.Unpaired)
        assertTrue(ended.heard)
    }

    @Test
    fun `it follows the newest entry, and the end, at the bottom, until the person scrolls up`() {
        val chat = Chat()
        chat.said((0 until 30).map { agentSaid("e$it", "$it") }, anew = true)
        assertEquals(0, chat.follow.list.firstVisibleItemIndex)

        // Scrolled up, back to older entries.
        chat.follow.on = false
        chat.follow.list.requestScrollToItem(5)
        chat.said(listOf(agentSaid("e30", "30")), anew = false)
        assertEquals(5, chat.follow.list.firstVisibleItemIndex)

        chat.follow.newest(0)
        chat.follow.list.requestScrollToItem(3)
        chat.end(ConversationEnded.NotHeld)
        assertEquals(0, chat.follow.list.firstVisibleItemIndex)
    }

    @Test
    fun `a run of two or more tools is one fold, keyed by its first, which stays the fold as more join it; one alone stays an entry`() {
        val chat = Chat()
        chat.said(listOf(person("e1", "Fix the nav"), toolUse("e2", use = "u1", name = "Read")), anew = true)
        assertEquals(listOf("e1", "e2"), chat.shown.map { it.key })

        chat.said(listOf(toolUse("e3", use = "u2", name = "Edit"), toolResult("e4", use = "u0", text = "from before")), anew = false)
        assertEquals(listOf("e1", "tools:e2"), chat.shown.map { it.key })
        assertEquals(listOf("e2", "e3", "e4"), (chat.shown[1] as Shown.Tools).entries.map { it.id })

        chat.said(listOf(agentSaid("e5", "Done."), toolUse("e6", use = "u3", name = "Bash")), anew = false)
        assertEquals(listOf("e1", "tools:e2", "e5", "e6"), chat.shown.map { it.key })
    }

    @Test
    fun `a fold counts each tool by what it does, in the order first used, a command as Run, and the ones that failed`() {
        val chat = Chat()
        chat.said(
            listOf(
                toolUse("e1", use = "u1", name = "Read"),
                toolUse("e2", use = "u2", name = "Bash"),
                toolResult("e3", use = "u2", text = "boom", error = true),
                toolUse("e4", use = "u3", name = "Read"),
                toolUse("e5", use = "u4", name = "exec_command"),
                toolResult("e6", use = "u0", text = "from before", error = true),
            ),
            anew = true,
        )
        val tools = (chat.shown.single() as Shown.Tools).entries

        assertEquals(ToolsSummary("Read 2 · Run 2 · Result 1", failed = 2), chat.summary(tools, orphan = "Result"))
    }

    @Test
    fun `told anew, the folds the person opened are closed`() {
        val chat = Chat()
        chat.said(listOf(toolUse("e1", use = "u1", name = "Read"), toolUse("e2", use = "u2", name = "Edit")), anew = true)
        chat.opened["tools:e1"] = true

        chat.said(listOf(toolUse("e1", use = "u1", name = "Read"), toolUse("e2", use = "u2", name = "Edit")), anew = true)

        assertNull(chat.opened["tools:e1"])
    }
}

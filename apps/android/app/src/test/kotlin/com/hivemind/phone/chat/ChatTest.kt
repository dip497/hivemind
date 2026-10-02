package com.hivemind.phone.chat

import com.hivemind.phone.agentSaid
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
    fun `why it ended is the last item, and is heard though nothing was said`() {
        val ended = Chat()
        ended.end("this phone is paired with nothing yet")
        assertTrue(ended.heard)
        assertEquals(0, ended.last)

        val chat = Chat()
        chat.said(listOf(agentSaid("e1", "Done.")), anew = true)
        chat.end("Desk does not hold that workspace now")
        assertEquals(1, chat.last)
    }

    @Test
    fun `it follows the newest entry, and the end, until the person scrolls up`() {
        val chat = Chat()
        chat.said((0 until 30).map { agentSaid("e$it", "$it") }, anew = true)
        assertEquals(29, chat.follow.list.firstVisibleItemIndex)

        chat.follow.on = false
        chat.said(listOf(agentSaid("e30", "30")), anew = false)
        assertEquals(29, chat.follow.list.firstVisibleItemIndex)

        chat.follow.newest(chat.last)
        chat.end("Desk does not hold that workspace now")
        assertEquals(31, chat.follow.list.firstVisibleItemIndex)
    }
}

package com.hivemind.phone.ui.agent

import com.hivemind.phone.agent
import org.junit.Assert.assertEquals
import org.junit.Test

/** What the Agent screen offers to show of an agent (design §6.4, P7). */
class ShownTest {
    @Test
    fun `the chat is offered only for an agent that keeps a conversation, and its terminal always`() {
        assertEquals(listOf(Shown.CHAT, Shown.TERMINAL), shownOf(agent("t1", hasConversation = true)))
        assertEquals(listOf(Shown.TERMINAL), shownOf(agent("t1")))
        // Not listed yet, a moment after it was started: its terminal.
        assertEquals(listOf(Shown.TERMINAL), shownOf(null))
    }
}

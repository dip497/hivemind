package com.hivemind.phone.ui.agent

import com.hivemind.phone.agent
import org.junit.Assert.assertEquals
import org.junit.Test

/** What the Agent screen opens on (design §6.4, P7). */
class OpensOnChatTest {
    @Test
    fun `an agent opens on its chat only when it keeps a conversation, any other on its terminal`() {
        assertEquals(true, opensOnChat(agent("t1", hasConversation = true)))
        assertEquals(false, opensOnChat(agent("t1")))
        // Not listed yet, a moment after it was started: its terminal.
        assertEquals(false, opensOnChat(null))
    }
}

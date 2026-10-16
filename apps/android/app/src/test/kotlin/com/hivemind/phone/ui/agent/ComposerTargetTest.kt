package com.hivemind.phone.ui.agent

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.fragment.app.FragmentActivity
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Conversation
import com.hivemind.phone.core.ConversationListener
import com.hivemind.phone.core.NoHandle
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.ScreenListener
import com.hivemind.phone.core.ScreenUpdate
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.core.Watch
import com.hivemind.phone.overview
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.PhoneLock
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.update
import com.hivemind.phone.waiting
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric

/** What is typed in an agent's chat goes to what it was typed for (design PB §12.12: one place to type). */
@RunWith(AndroidJUnit4::class)
class ComposerTargetTest {
    @get:Rule
    val compose = createComposeRule()

    private class Screen : Watch(NoHandle) {
        override fun update(since: ULong): ScreenUpdate = update(1, 0, 0, emptyList())
        override fun stop() {}
        override fun typeKeys(keys: List<String>) {}
        override fun typeText(text: String) {}
    }

    private class Talk : Conversation(NoHandle) {
        override fun stop() {}
    }

    private class Computer : Phone(NoHandle) {
        val answered = mutableListOf<Pair<ULong, Answer>>()
        val sent = mutableListOf<String>()

        override fun watch(agent: AgentRef, listener: ScreenListener): Watch = Screen()

        override fun conversation(agent: AgentRef, listener: ConversationListener): Conversation {
            listener.said(emptyList(), true)
            return Talk()
        }

        override suspend fun answer(agent: AgentRef, since: ULong, answer: Answer): Boolean {
            answered += since to answer
            return true
        }

        override suspend fun send(agent: AgentRef, text: String): Boolean {
            sent += text
            return true
        }
    }

    @Test
    fun `an answer typed for one wait is not sent to the next, nor a message sent as an answer, until Send is pressed again`() {
        val first = agent("t1", state = AgentState.WAITING, hasConversation = true, waiting = waiting(WaitKind.OTHER, since = 100))
        val agents = MutableStateFlow(overview(agents = listOf(first)))
        val computer = Computer()
        val vm = AgentViewModel(computer, agents, first.at)
        val lock = PhoneLock(Robolectric.buildActivity(FragmentActivity::class.java).create().get())
        compose.setContent {
            PhoneTheme(accent = null) {
                CompositionLocalProvider(LocalPhoneLock provides lock) { AgentScreen(vm, onBack = {}, onDiff = {}, onClosed = {}) }
            }
        }

        compose.onNodeWithTag("reply").performTextInput("yes, the second one")
        // Answered elsewhere meanwhile; the agent now waits on something else.
        agents.value = overview(agents = listOf(first.copy(waiting = waiting(WaitKind.OTHER, since = 200))))
        compose.waitForIdle()
        compose.onNodeWithTag("reply-send").performClick()
        compose.waitForIdle()

        assertEquals(emptyList<Pair<ULong, Answer>>(), computer.answered)
        compose.onNodeWithText("What it waits on changed since you began typing. Read it, then send again.").assertExists()

        compose.onNodeWithTag("reply-send").performClick()
        compose.waitForIdle()
        assertEquals(listOf(200uL to Answer.Text("yes, the second one")), computer.answered)
        assertEquals(emptyList<String>(), computer.sent)
    }
}

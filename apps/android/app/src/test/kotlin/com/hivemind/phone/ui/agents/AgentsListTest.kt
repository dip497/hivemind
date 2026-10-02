package com.hivemind.phone.ui.agents

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.agent
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.overview
import com.hivemind.phone.ui.theme.PhoneTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The Agents tab's rows, over the core's records (design §6.3). */
@RunWith(AndroidJUnit4::class)
class AgentsListTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `a row swiped right stops an agent's turn, and nothing that has no turn to stop`() {
        val stopped = mutableListOf<String>()
        val closed = mutableListOf<String>()
        val agents = listOf(
            agent("t1", name = "builder", state = AgentState.WORKING, canInterrupt = true),
            agent("t2", name = "reviewer", state = AgentState.IDLE, canInterrupt = true),
            agent("t3", name = "tester", state = AgentState.WORKING, canInterrupt = false),
            agent("t4", name = "asker", state = AgentState.WAITING, canInterrupt = true),
        )
        compose.setContent {
            PhoneTheme(accent = null) {
                AgentsList(
                    AgentsState.of(overview(agents = agents)),
                    busy = emptySet(),
                    now = 0,
                    onOpen = {},
                    onStop = { stopped += it.name },
                    onClose = { closed += it.name },
                )
            }
        }

        for (name in listOf("builder", "reviewer", "tester", "asker")) compose.onNodeWithText(name).performTouchInput { swipeRight() }
        compose.onNodeWithText("reviewer").performTouchInput { swipeLeft() }
        compose.waitForIdle()

        assertEquals(listOf("builder", "asker"), stopped)
        assertEquals(listOf("reviewer"), closed)
    }
}

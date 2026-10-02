package com.hivemind.phone.ui.needs

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.MINUTE
import com.hivemind.phone.agent
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Decision
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.device
import com.hivemind.phone.overview
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.waiting
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The Needs you tab, over the core's records (design §6.2). */
@RunWith(AndroidJUnit4::class)
class NeedsListTest {
    @get:Rule
    val compose = createComposeRule()

    private val now = 1_790_000_000_000L
    private val answers = mutableListOf<Pair<Agent, Answer>>()

    private fun show(state: NeedsState) = compose.setContent {
        PhoneTheme(accent = null) {
            NeedsList(state, busy = emptySet(), now = now, onOpen = {}, onAnswer = { agent, answer -> answers += agent to answer })
        }
    }

    @Test
    fun `a permission the device can decide is allowed from its row`() {
        val asking = agent("t1", name = "fix the login bug", waiting = waiting(WaitKind.PERMISSION, since = now - 5 * MINUTE, decide = true))
        show(NeedsState.of(overview(needs = listOf(asking))))

        compose.onNodeWithText("fix the login bug").assertIsDisplayed()
        compose.onNodeWithText("5 min").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
        compose.onNodeWithText("Allow").performClick()

        assertEquals(listOf(asking to Answer.Decide(Decision.ALLOW)), answers)
    }

    @Test
    fun `a question is answered with the line typed in its reply box`() {
        val asking = agent("t2", name = "migrate the db", waiting = waiting(WaitKind.QUESTION, since = now - MINUTE))
        show(NeedsState.of(overview(needs = listOf(asking))))

        compose.onNodeWithText("Reply").performTextInput("yes, the staging one")
        compose.onNodeWithText("Send").performClick()

        assertEquals(listOf(asking to Answer.Text("yes, the staging one")), answers)
    }

    @Test
    fun `with nothing waiting it says so and how many agents work, and when an away device was last heard`() {
        show(
            NeedsState.of(
                overview(
                    working = 4,
                    devices = listOf(device(DESK, "desk", reachable = false, awaySince = now - 2 * MINUTE, heardAt = now - 5 * MINUTE)),
                ),
            ),
        )

        compose.onNodeWithText("Nothing needs you. 4 agents working.").assertIsDisplayed()
        compose.onNodeWithText("desk is away · last heard 5 min ago").assertIsDisplayed()
    }

    @Test
    fun `a device reached that has not said what waits there is being asked, and nothing is said to wait until it has`() {
        // It told the workspaces it holds a moment ago, and not yet what waits there.
        show(NeedsState.of(overview(working = 0, devices = listOf(device(DESK, "desk", heardAt = now - 1_000, answeredAt = null)))))

        compose.onNodeWithText("Asking desk…").assertIsDisplayed()
        compose.onNodeWithText("Nothing needs you.").assertDoesNotExist()
    }
}

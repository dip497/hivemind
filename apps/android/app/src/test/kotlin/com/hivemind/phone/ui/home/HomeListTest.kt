package com.hivemind.phone.ui.home

import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.DESK
import com.hivemind.phone.MINUTE
import com.hivemind.phone.agent
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Decision
import com.hivemind.phone.core.HomeEntry
import com.hivemind.phone.core.HomeShown
import com.hivemind.phone.core.HomeTile
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.QuestionAnswer
import com.hivemind.phone.core.ToolAsked
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.device
import com.hivemind.phone.overview
import com.hivemind.phone.question
import com.hivemind.phone.ui.theme.PhoneTheme
import com.hivemind.phone.waiting
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Home (B5 §11.2), over the core's records: what needs the person, and each computer's tree. */
@RunWith(AndroidJUnit4::class)
class HomeListTest {
    @get:Rule
    val compose = createComposeRule()

    private val now = 1_790_000_000_000L
    private val answers = mutableListOf<Pair<Agent, Answer>>()
    private val opened = mutableListOf<AgentRef>()
    private val stopped = mutableListOf<String>()
    private val closed = mutableListOf<String>()
    private val folds = mutableListOf<String>()

    /** The line saying [text], scrolled to as the person scrolls the list to it. */
    private fun row(text: String): SemanticsNodeInteraction {
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasText(text))
        return compose.onNodeWithText(text)
    }

    private fun show(overview: Overview, homes: List<HomeShown> = emptyList()) = compose.setContent {
        PhoneTheme(accent = null) {
            HomeList(
                HomeState.of(overview, homes, HomeFilter()),
                busy = emptySet(),
                now = now,
                onSearch = {},
                onMachine = {},
                onOpen = { opened += it },
                onAnswer = { agent, answer -> answers += agent to answer },
                onStop = { stopped += it.name },
                onClose = { closed += it.name },
                onStart = {},
                onFold = { folds += it },
            )
        }
    }

    @Test
    fun `a permission the device can decide is allowed from its row, below its tool and command`() {
        val bash = ToolAsked(name = "Bash", about = "rm -rf build")
        val asking = agent("t1", name = "fix the login bug", waiting = waiting(WaitKind.PERMISSION, since = now - 5 * MINUTE, decide = true, tool = bash))
        show(overview(needs = listOf(asking)))

        compose.onNodeWithText("fix the login bug").assertIsDisplayed()
        compose.onNodeWithText("5 min").assertIsDisplayed()
        compose.onNodeWithText("Bash").assertIsDisplayed()
        compose.onNodeWithText("rm -rf build").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
        compose.onNodeWithText("Allow").performClick()

        assertEquals(listOf(asking to Answer.Decide(Decision.ALLOW)), answers)
    }

    @Test
    fun `a question is answered with the line typed in its reply box`() {
        val asking = agent("t2", name = "migrate the db", waiting = waiting(WaitKind.QUESTION, since = now - MINUTE))
        show(overview(needs = listOf(asking)))

        compose.onNodeWithText("Reply").performTextInput("yes, the staging one")
        compose.onNodeWithText("Send").performClick()

        assertEquals(listOf(asking to Answer.Text("yes, the staging one")), answers)
    }

    @Test
    fun `an option of the one question it asks answers it at once`() {
        val which = question("Which database?", "staging", "production")
        val asking = agent("t2", name = "migrate the db", waiting = waiting(WaitKind.QUESTION, since = now - MINUTE, questions = listOf(which), choose = true))
        show(overview(needs = listOf(asking)))

        compose.onNodeWithText("Which database?").assertIsDisplayed()
        compose.onNodeWithText("production").performClick()

        assertEquals(listOf(asking to Answer.Questions(listOf(QuestionAnswer.Chosen(listOf(1u))))), answers)
    }

    @Test
    fun `several questions are each answered in their place, then sent together`() {
        val color = question("Which color?", "Red", "Green", "Blue")
        val sizes = question("Which sizes?", "Small", "Medium", "Large", many = true)
        val asking = agent("t2", name = "order shirts", waiting = waiting(WaitKind.QUESTION, since = now - MINUTE, questions = listOf(color, sizes), choose = true))
        show(overview(needs = listOf(asking)))

        row("Large").performClick()
        row("Small").performClick()
        row("Send").performClick()
        assertEquals("nothing is sent before each question has an answer", emptyList<Pair<Agent, Answer>>(), answers)

        row("Green").performClick()
        row("Send").performClick()

        val chosen = listOf(QuestionAnswer.Chosen(listOf(1u)), QuestionAnswer.Chosen(listOf(0u, 2u)))
        assertEquals(listOf(asking to Answer.Questions(chosen)), answers)
    }

    @Test
    fun `with nothing waiting it says so and how many agents work, and when an away device was last heard`() {
        show(
            overview(
                working = 4,
                devices = listOf(device(DESK, "desk", reachable = false, awaySince = now - 2 * MINUTE, heardAt = now - 5 * MINUTE)),
            ),
        )

        compose.onNodeWithText("Nothing needs you. 4 agents working.").assertIsDisplayed()
        compose.onNodeWithText("desk is away · last heard 5 min ago").assertIsDisplayed()
    }

    @Test
    fun `a device reached that has not said what waits there is being asked, and nothing is said to wait until it has`() {
        // It told the workspaces it holds a moment ago, and not yet what waits there.
        show(overview(working = 0, devices = listOf(device(DESK, "desk", heardAt = now - 1_000, answeredAt = null))))

        compose.onNodeWithText("Asking desk…").assertIsDisplayed()
        compose.onNodeWithText("Nothing needs you.").assertDoesNotExist()
    }

    @Test
    fun `a computer's tree lists its machine, project, frame and tiles, an agent's row saying what it waits on and opening it, a shell's saying its last line`() {
        val asking = agent("t1", name = "api", state = AgentState.WAITING, waiting = waiting(WaitKind.PERMISSION, since = now - MINUTE))
        fun tile(id: String, name: String, agent: Boolean, line: String? = null, tool: String? = null, about: String? = null) = HomeEntry.Tile(
            key = "t:ws-1/$id",
            depth = 2u,
            tile = HomeTile(
                at = AgentRef(DESK, "ws-1", id), name = name, kind = "terminal", agent = agent, terminal = true,
                state = if (agent) AgentState.WAITING else null, since = null, waits = if (agent) WaitKind.PERMISSION else null,
                tool = tool, about = about, question = null, line = line, program = null, interrupt = false, runs = null, unread = false,
            ),
        )
        val home = HomeShown(
            device = DESK, computer = "desk", needs = listOf(asking.at), working = emptyList(), pinned = emptyList(), machines = emptyList(),
            tree = listOf(
                HomeEntry.Machine("m:desk", "desk"),
                HomeEntry.Project("p:ws-1", "hivemind", "ws-1", null, count = 1u, state = AgentState.WAITING, folded = false),
                HomeEntry.Frame("f:ws-1/f1", 1u, "nav fix", "#3a7bd5", "nav-fix", worktree = false, branch = null, count = 2u, state = AgentState.WAITING, folded = false),
                tile("t1", "api", agent = true, tool = "Bash", about = "rm -rf build"),
                tile("t2", "shell", agent = false, line = "$ make"),
            ),
            marks = emptyMap(),
        )
        show(overview(agents = listOf(asking), needs = listOf(asking)), listOf(home))

        row("hivemind").assertIsDisplayed()
        row("nav fix").assertIsDisplayed()
        row("nav-fix").assertIsDisplayed()
        row("Bash: rm -rf build").assertIsDisplayed()
        row("$ make").assertIsDisplayed()
        row("Bash: rm -rf build").performClick()

        assertEquals(listOf(asking.at), opened)
    }

    @Test
    fun `the agents of a computer whose Home has not come yet are listed by the overview, and swiped right stop a turn, only one there is to stop, and left close`() {
        val agents = listOf(
            agent("t1", name = "builder", state = AgentState.WORKING, canInterrupt = true),
            agent("t2", name = "reviewer", state = AgentState.IDLE, canInterrupt = true),
            agent("t3", name = "tester", state = AgentState.WORKING, canInterrupt = false),
            agent("t4", name = "asker", state = AgentState.WAITING, canInterrupt = true),
        )
        show(overview(agents = agents))

        for (name in listOf("builder", "reviewer", "tester", "asker")) row(name).performTouchInput { swipeRight() }
        row("reviewer").performTouchInput { swipeLeft() }
        compose.waitForIdle()

        assertEquals(listOf("builder", "asker"), stopped)
        assertEquals(listOf("reviewer"), closed)
    }

    @Test
    fun `a project, a frame and a section fold by their key when tapped, each arrow saying which way it goes`() {
        val home = HomeShown(
            device = DESK, computer = "desk", needs = emptyList(), working = emptyList(), pinned = emptyList(), machines = emptyList(),
            tree = listOf(
                HomeEntry.Project("p:ws-1", "hivemind", "ws-1", null, count = 1u, state = null, folded = false),
                HomeEntry.Frame("f:ws-1/f1", 1u, "nav fix", "#3a7bd5", null, worktree = false, branch = null, count = 0u, state = null, folded = true),
                HomeEntry.Section("s:waiting", "Waiting", count = 0u, state = null, folded = false),
            ),
            marks = emptyMap(),
        )
        show(overview(), listOf(home))

        compose.onNodeWithContentDescription("Hide what is in hivemind").assertExists()
        compose.onNodeWithContentDescription("Show what is in nav fix").assertExists()
        row("hivemind").performClick()
        row("nav fix").performClick()
        row("WAITING").performClick()

        assertEquals(listOf("p:ws-1", "f:ws-1/f1", "s:waiting"), folds)
    }

    @Test
    fun `what needs the person says so on its tile and on the frame it is in, and a tile done since last looked at shows a dot`() {
        fun tile(id: String, state: AgentState, unread: Boolean) = HomeEntry.Tile(
            key = "t:ws-1/$id",
            depth = 2u,
            tile = HomeTile(
                at = AgentRef(DESK, "ws-1", id), name = id, kind = "terminal", agent = true, terminal = true, state = state, since = null,
                waits = null, tool = null, about = null, question = null, line = "said $id", program = null, interrupt = false,
                runs = "claude", unread = unread,
            ),
        )
        val home = HomeShown(
            device = DESK, computer = "desk", needs = emptyList(), working = emptyList(), pinned = emptyList(), machines = emptyList(),
            tree = listOf(
                HomeEntry.Project("p:ws-1", "hivemind", "ws-1", null, count = 1u, state = AgentState.WAITING, folded = false),
                HomeEntry.Frame("f:ws-1/f1", 1u, "nav fix", "#3a7bd5", null, worktree = true, branch = "nav-fix", count = 3u, state = AgentState.WAITING, folded = false),
                tile("asker", AgentState.WAITING, unread = false),
                tile("finished", AgentState.IDLE, unread = true),
                tile("resting", AgentState.IDLE, unread = false),
            ),
            marks = emptyMap(),
        )
        show(overview(), listOf(home))

        row("nav-fix").assertIsDisplayed()
        compose.onAllNodesWithText("Needs you").assertCountEquals(3)
        compose.onAllNodesWithContentDescription("Done since you last looked").assertCountEquals(1)
        row("said finished").assertIsDisplayed()
    }

    @Test
    fun `the View menu shows each group's choice, and a choice tapped is taken for its group`() {
        val chosen = mutableListOf<Pair<ViewGroup, String>>()
        compose.setContent { PhoneTheme(accent = null) { ViewChoices(FirstChoices.copy(sortBy = "name")) { group, id -> chosen += group to id } } }

        compose.onNodeWithText("Name").assertIsSelected()
        compose.onNodeWithText("Canvas order").assertIsNotSelected()
        compose.onNodeWithText("Last activity").performClick()
        compose.onNodeWithText("Agent").performClick()
        compose.onNodeWithText("Past hour").performClick()
        compose.onAllNodesWithText("Needs you")[0].performClick()

        assertEquals(
            listOf(ViewGroup.SORT_BY to "activity", ViewGroup.GROUP_BY to "agent", ViewGroup.ACTIVITY to "hour", ViewGroup.STATUS to "needs-you"),
            chosen,
        )
    }
}

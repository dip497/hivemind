package com.hivemind.phone.chat

import androidx.compose.foundation.layout.size
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.agentSaid
import com.hivemind.phone.person
import com.hivemind.phone.toolResult
import com.hivemind.phone.toolUse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The chat as drawn (design P7): who said what, each tool on a row of its own, following the newest. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "mdpi")
class ChatViewTest {
    @get:Rule
    val compose = createComposeRule()

    private fun show(chat: Chat) = compose.setContent { ChatView(chat, Modifier.size(300.dp, 400.dp)) }

    private fun SemanticsNodeInteraction.textColor(): Color {
        val layouts = mutableListOf<TextLayoutResult>()
        fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single().layoutInput.style.color
    }

    @Test
    fun `Nothing said yet once the core has told nothing, not before`() {
        val chat = Chat()
        show(chat)
        compose.onNodeWithText("Nothing said yet").assertDoesNotExist()

        chat.said(emptyList(), anew = true)

        compose.onNodeWithText("Nothing said yet").assertIsDisplayed()
    }

    @Test
    fun `the person's words are drawn as typed, and the agent's markdown without its marks`() {
        val chat = Chat()
        chat.said(listOf(person("e1", "Fix the **nav**"), agentSaid("e2", "## Done\n- **moved** `nav.ts`")), anew = true)
        show(chat)

        compose.onNodeWithText("Fix the **nav**").assertIsDisplayed()
        compose.onNodeWithText("Done").assertIsDisplayed()
        compose.onNodeWithText("moved nav.ts").assertIsDisplayed()
    }

    @Test
    fun `a tool's row unfolds what it gave back, red when it failed`() {
        val chat = Chat()
        chat.said(
            listOf(
                toolUse("e1", use = "u1", name = "Bash", about = "make test"),
                toolResult("e2", use = "u1", text = "2 failed", error = true),
                toolUse("e3", use = "u2", name = "Read", about = "src/nav.ts"),
                toolResult("e4", use = "u2", text = "export const nav = []"),
            ),
            anew = true,
        )
        show(chat)
        compose.onNodeWithText("2 failed").assertDoesNotExist()

        compose.onNodeWithText("Bash · make test").performClick()
        compose.onNodeWithText("Read · src/nav.ts").performClick()

        // The text itself, not the row it is merged into for tapping.
        val colors = lightColorScheme()
        assertEquals(colors.error, compose.onNodeWithText("2 failed", useUnmergedTree = true).textColor())
        assertEquals(colors.onSurface, compose.onNodeWithText("export const nav = []", useUnmergedTree = true).textColor())
    }

    @Test
    fun `why it ended is a note after the last entry`() {
        val chat = Chat()
        chat.said(listOf(agentSaid("e1", "Done.")), anew = true)
        chat.end("Desk does not hold that workspace now")
        show(chat)

        val note = compose.onNodeWithText("Not followed any more: Desk does not hold that workspace now")
        note.assertIsDisplayed()
        assertTrue(note.getUnclippedBoundsInRoot().top > compose.onNodeWithText("Done.").getUnclippedBoundsInRoot().bottom)
    }

    @Test
    fun `scrolled up, it stays where the person is as more is said, and the button goes back to the newest`() {
        val chat = Chat()
        chat.said((0 until 40).map { agentSaid("e$it", "line $it") }, anew = true)
        show(chat)
        compose.waitForIdle()
        assertEquals(39, chat.follow.list.layoutInfo.visibleItemsInfo.last().index)

        compose.onRoot().performTouchInput { swipeDown() }
        compose.waitForIdle()
        assertFalse(chat.follow.on)
        val at = chat.follow.list.firstVisibleItemIndex
        chat.said(listOf(agentSaid("e40", "line 40")), anew = false)
        compose.waitForIdle()
        assertEquals(at, chat.follow.list.firstVisibleItemIndex)

        compose.onNodeWithContentDescription("To the newest").performClick()
        compose.waitForIdle()
        assertTrue(chat.follow.on)
        assertEquals(40, chat.follow.list.layoutInfo.visibleItemsInfo.last().index)
    }
}

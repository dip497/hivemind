package com.hivemind.phone.chat

import androidx.compose.foundation.layout.size
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.agentSaid
import com.hivemind.phone.core.ConversationEnded
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

/** The chat as drawn (design P7): who said what, each tool on a row of its own, the newest at the bottom, followed. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "mdpi")
class ChatViewTest {
    @get:Rule
    val compose = createComposeRule()

    private fun show(chat: Chat) = compose.setContent { ChatView(chat, onTool = {}, modifier = Modifier.size(300.dp, 400.dp)) }

    private fun SemanticsNodeInteraction.layout(): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    private fun SemanticsNodeInteraction.textColor(): Color = layout().layoutInput.style.color

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
    fun `a tool's row is one line that opens the use on its own screen, whole, red when it failed`() {
        val path = "/home/priya/projects/hivemind/apps/android/app/src/main/kotlin/com/hivemind/phone/chat/ChatView.kt"
        val chat = Chat()
        chat.said(
            listOf(
                toolUse("e1", use = "u1", name = "Bash", about = "make test"),
                toolResult("e2", use = "u1", text = "2 failed", error = true),
                toolUse("e3", use = "u2", name = "Read", about = path),
                toolResult("e4", use = "u2", text = "export const nav = []"),
            ),
            anew = true,
        )
        compose.setContent {
            var open by remember { mutableStateOf<String?>(null) }
            when (val entry = open) {
                null -> ChatView(chat, onTool = { open = it }, modifier = Modifier.size(300.dp, 400.dp))
                else -> ToolScreen(chat.toolCall(entry), onBack = { open = null })
            }
        }
        compose.onNodeWithText("2 failed").assertDoesNotExist()
        // Two tools one after another are one row, counting them, until it is opened.
        compose.onNodeWithText("make test").assertDoesNotExist()
        compose.onNodeWithText("Run 1 · Read 1").performClick()
        // A path too long for the row stays on one line, cut in the middle: its file's name is drawn.
        val row = compose.onNodeWithText(path, useUnmergedTree = true).layout()
        assertEquals(1, row.lineCount)
        assertTrue(row.isLineEllipsized(0))
        assertTrue(row.getBoundingBox(path.length - 1).width > 0f)

        compose.onNodeWithText("make test").performClick()

        val colors = lightColorScheme()
        assertEquals(colors.error, compose.onNodeWithText("2 failed").textColor())
        compose.onNodeWithTag("tool-back").performClick()
        // Back from a tool, its fold is still open.
        compose.onNodeWithText(path).performClick()
        compose.onNodeWithText(path).assertIsDisplayed()
        assertTrue(compose.onNodeWithText(path).layout().lineCount > 1)
        assertEquals(colors.onSurface, compose.onNodeWithText("export const nav = []").textColor())
    }

    @Test
    fun `what the agent waits on is the chat's last item, under what it said last`() {
        val chat = Chat()
        chat.said((0 until 40).map { agentSaid("e$it", "line $it") }, anew = true)
        compose.setContent {
            ChatView(chat, onTool = {}, modifier = Modifier.size(300.dp, 400.dp), endKey = 1L, end = { Text("Allow make test?") })
        }

        val card = compose.onNodeWithText("Allow make test?")
        card.assertIsDisplayed()
        assertTrue(card.getUnclippedBoundsInRoot().top > compose.onNodeWithText("line 39").getUnclippedBoundsInRoot().bottom)
    }

    @Test
    fun `a keyboard that opens leaves the newest where the person reads it, at the bottom`() {
        val chat = Chat()
        chat.said((0 until 40).map { agentSaid("e$it", "line $it") }, anew = true)
        var height by mutableStateOf(400.dp)
        compose.setContent { ChatView(chat, onTool = {}, modifier = Modifier.size(300.dp, height)) }
        compose.waitForIdle()

        height = 200.dp
        compose.waitForIdle()

        compose.onNodeWithText("line 39").assertIsDisplayed()
        assertTrue(compose.onNodeWithText("line 39").getUnclippedBoundsInRoot().bottom > 180.dp)
    }

    @Test
    fun `why it ended is a note after the last entry`() {
        val chat = Chat()
        chat.said(listOf(agentSaid("e1", "Done.")), anew = true)
        chat.end(ConversationEnded.Refused("no agent runs there"))
        show(chat)

        val note = compose.onNodeWithText("Not followed any more: no agent runs there")
        note.assertIsDisplayed()
        assertTrue(note.getUnclippedBoundsInRoot().top > compose.onNodeWithText("Done.").getUnclippedBoundsInRoot().bottom)
    }

    @Test
    fun `scrolled up, it stays where the person is as more is said, and the button goes back to the newest`() {
        val chat = Chat()
        chat.said((0 until 40).map { agentSaid("e$it", "line $it") }, anew = true)
        show(chat)
        compose.waitForIdle()
        assertEquals(0, chat.follow.list.firstVisibleItemIndex)

        compose.onRoot().performTouchInput { swipeDown() }
        compose.waitForIdle()
        assertFalse(chat.follow.on)
        val at = chat.follow.list.layoutInfo.visibleItemsInfo.first().key
        chat.said(listOf(agentSaid("e40", "line 40")), anew = false)
        compose.waitForIdle()
        assertEquals(at, chat.follow.list.layoutInfo.visibleItemsInfo.first().key)

        compose.onNodeWithContentDescription("To the newest").performClick()
        compose.waitForIdle()
        assertTrue(chat.follow.on)
        assertEquals(0, chat.follow.list.firstVisibleItemIndex)
        compose.onNodeWithText("line 40").assertIsDisplayed()
    }

    @Test
    fun `tools used one after another are one row that counts them and says how many failed, and opens to them in order`() {
        val chat = Chat()
        chat.said(
            listOf(
                person("e0", "Fix the nav"),
                toolUse("e1", use = "u1", name = "Read", about = "nav.ts"),
                toolUse("e2", use = "u2", name = "Edit", about = "nav.ts"),
                toolUse("e3", use = "u3", name = "Bash", about = "make test"),
                toolResult("e4", use = "u3", text = "1 failed", error = true),
                toolUse("e5", use = "u4", name = "Read", about = "test.ts"),
                agentSaid("e6", "One test fails."),
                toolUse("e7", use = "u5", name = "Grep", about = "nav"),
            ),
            anew = true,
        )
        show(chat)

        compose.onNodeWithText("Read 2 · Edit 1 · Run 1").assertIsDisplayed()
        compose.onNodeWithText("· 1 failed").assertIsDisplayed()
        compose.onNodeWithText("test.ts").assertDoesNotExist()
        // One alone stays a row of its own.
        compose.onNodeWithText("nav", useUnmergedTree = true).assertIsDisplayed()

        compose.onNodeWithText("Read 2 · Edit 1 · Run 1").performClick()

        val tops = listOf("nav.ts", "make test", "test.ts").map { about ->
            compose.onAllNodesWithText(about, useUnmergedTree = true).fetchSemanticsNodes().first().boundsInRoot.top
        }
        assertEquals(tops.sorted(), tops)
    }
}

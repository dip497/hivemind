package com.hivemind.phone.chat

import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.size
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hivemind.phone.agentSaid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** What an agent says, as the chat draws it (spec/markdown.md): read by the core, drawn natively, its
 *  text laid out as on a phone. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w360dp-h640dp-mdpi")
class MarkdownTest {
    @get:Rule
    val compose = createComposeRule()

    private fun said(markdown: String) {
        val chat = Chat()
        chat.said(listOf(agentSaid("e1", markdown)), anew = true)
        compose.setContent { ChatView(chat, Modifier.size(360.dp, 640.dp)) }
    }

    private fun SemanticsNodeInteraction.text(): AnnotatedString =
        fetchSemanticsNode().config[SemanticsProperties.Text].single()

    private fun SemanticsNodeInteraction.layout(): TextLayoutResult {
        val layouts = mutableListOf<TextLayoutResult>()
        fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        return layouts.single()
    }

    private fun left(text: String) = compose.onNodeWithText(text).getUnclippedBoundsInRoot().left

    /** Each part of `text` its span styles mark, with what they mark it with. */
    private fun AnnotatedString.styled(): List<Pair<String, String>> = spanStyles.map { span ->
        val s = span.item
        text.substring(span.start, span.end) to listOfNotNull(
            "bold".takeIf { s.fontWeight == FontWeight.Bold },
            "italic".takeIf { s.fontStyle == FontStyle.Italic },
            "struck".takeIf { s.textDecoration?.contains(TextDecoration.LineThrough) == true },
            "mono".takeIf { s.fontFamily != null },
        ).joinToString(" ")
    }.filter { it.second.isNotEmpty() }

    private fun AnnotatedString.links(): List<Pair<String, String>> =
        getLinkAnnotations(0, length).map { text.substring(it.start, it.end) to (it.item as LinkAnnotation.Url).url }

    @Test
    fun `emphasis is italic, strikethrough struck, strong bold, code monospace, and a mark not closed is a character written`() {
        said("a *it* ~~gone~~ **bold** `x()` 2*3")

        val text = compose.onNodeWithText("a it gone bold x() 2*3").text()
        assertEquals(listOf("it" to "italic", "gone" to "struck", "bold" to "bold", "x()" to "mono"), text.styled())
    }

    @Test
    fun `a heading is drawn at its level, larger than the text, the higher the larger`() {
        said("# One\n\n### Three\n\ntext")

        val size = { t: String -> compose.onNodeWithText(t).layout().layoutInput.style.fontSize.value }
        assertTrue(size("One") > size("Three"))
        assertTrue(size("Three") > size("text"))
        assertEquals(Unit, compose.onNodeWithText("One").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Heading))
    }

    @Test
    fun `fenced code is drawn as written, under its language`() {
        said("```rust\nlet x = **1**;\n```")

        compose.onNodeWithText("let x = **1**;").assertIsDisplayed()
        assertTrue(compose.onNodeWithText("rust").getUnclippedBoundsInRoot().bottom <= compose.onNodeWithText("let x = **1**;").getUnclippedBoundsInRoot().top)
    }

    @Test
    fun `a table's cells line up in their columns, aligned as each column says`() {
        said("| name | n |\n|:--|--:|\n| a | **1** |\n| bbbbbb | 22 |")

        val bounds = { t: String -> compose.onNodeWithText(t).getUnclippedBoundsInRoot() }
        assertEquals(bounds("name").left, bounds("bbbbbb").left)
        assertEquals(bounds("1").right, bounds("22").right)
        assertTrue(bounds("1").left > bounds("22").left)
        assertTrue(bounds("n").left > bounds("bbbbbb").right)
        assertEquals(listOf("1" to "bold"), compose.onNodeWithText("1").text().styled())
    }

    @Test
    fun `a link to an https address, written or bare, is one, and any other stays text with nothing to tap`() {
        said("[site](https://example.com/a) and https://b.io/c. [x](javascript:alert(1)) [y](http://plain.io)")

        val text = compose.onNodeWithText("site and https://b.io/c. x y").text()
        assertEquals(listOf("site" to "https://example.com/a", "https://b.io/c" to "https://b.io/c"), text.links())
    }

    @Test
    fun `a nested list's items are drawn further in, each after its bullet or number`() {
        said("- outer\n  - inner\n\n3. three\n4. four")

        assertEquals(2, compose.onAllNodesWithText("•").fetchSemanticsNodes().size)
        compose.onNodeWithText("3.").assertIsDisplayed()
        assertTrue(left("inner") > left("outer"))
        assertEquals(left("three"), left("outer"))
        assertTrue(left("outer") > left("3."))
    }

    @Test
    fun `a task list's items show whether each is done`() {
        said("- [ ] todo\n- [x] done")

        assertTrue(compose.onNodeWithText("☐").getUnclippedBoundsInRoot().top < compose.onNodeWithText("☑").getUnclippedBoundsInRoot().top)
        assertEquals(compose.onNodeWithText("☑").getUnclippedBoundsInRoot().top, compose.onNodeWithText("done").getUnclippedBoundsInRoot().top)
    }

    @Test
    fun `a quote is drawn set in, a quote in it further, and a rule apart`() {
        said("> said\n>\n> > deeper\n\n---\n\nafter")

        assertTrue(left("deeper") > left("said"))
        assertTrue(left("said") > left("after"))
        compose.onAllNodesWithText("---").assertCountEquals(0)
    }

    @Test
    fun `an image is shown by its words, a link only when its address is https`() {
        said("![a cat](https://e.com/c.png) ![x](http://e.com/d.png)")

        val text = compose.onNodeWithText("a cat", substring = true).text()
        assertEquals(listOf("🖼 a cat" to "https://e.com/c.png"), text.links())
        assertTrue(text.text.contains("🖼 x"))
    }

    @Test
    fun `a paragraph whose first letter is Arabic is drawn from the right, an English one from the left`() {
        said("(1) هذا نص عربي.\n\nThis is English.")

        // Where each line ends in the chat, 360 wide with 12 either side, at mdpi a pixel a dp.
        val ends = { t: String ->
            val left = compose.onNodeWithText(t).getUnclippedBoundsInRoot().left.value
            val layout = compose.onNodeWithText(t).layout()
            left + layout.getLineLeft(0) to left + layout.getLineRight(0)
        }
        assertEquals(348f, ends("(1) هذا نص عربي.").second, 1f)
        assertTrue(ends("(1) هذا نص عربي.").first > 12f)
        assertEquals(12f, ends("This is English.").first, 1f)
        assertTrue(ends("This is English.").second < 348f)
    }

    @Test
    fun `raw HTML is drawn as the text it is`() {
        said("<b>hi</b> there")

        compose.onNodeWithText("<b>hi</b> there").assertIsDisplayed()
    }
}

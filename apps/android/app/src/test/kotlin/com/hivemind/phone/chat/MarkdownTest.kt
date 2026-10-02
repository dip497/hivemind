package com.hivemind.phone.chat

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Test

/** The little of markdown agents write, as the chat cuts and marks it (design P7). */
class MarkdownTest {
    private val code = SpanStyle(fontFamily = FontFamily.Monospace)
    private val strong = SpanStyle(fontWeight = FontWeight.Bold)

    private fun AnnotatedString.marks() = spanStyles.map { Triple(text.substring(it.start, it.end), it.start, it.item) }

    @Test
    fun `headings, list items and paragraphs are cut apart, and fenced code is kept as written`() {
        val said = """
            # Plan
            Two steps,
            then a test.

            - read `nav.ts`
            * fix it
            12. test

            ```kotlin
            val x = 1

            # not a heading
            ```
            After.
        """.trimIndent()

        assertEquals(
            listOf(
                Block.Heading("Plan"),
                Block.Text("Two steps,\nthen a test."),
                Block.Item("•", "read `nav.ts`"),
                Block.Item("•", "fix it"),
                Block.Item("12.", "test"),
                Block.Code("val x = 1\n\n# not a heading"),
                Block.Text("After."),
            ),
            blocks(said),
        )
    }

    @Test
    fun `a fence not closed yet is code to the end`() {
        assertEquals(listOf(Block.Text("Look:"), Block.Code("still\ngoing")), blocks("Look:\n```\nstill\ngoing"))
    }

    @Test
    fun `code and strong are marked, and a mark not closed is only a character`() {
        val marked = inline("run `make` **now**, it`s **done**", code, strong)

        assertEquals("run make now, it`s done", marked.text)
        assertEquals(listOf(Triple("make", 4, code), Triple("now", 9, strong), Triple("done", 19, strong)), marked.marks())
    }
}

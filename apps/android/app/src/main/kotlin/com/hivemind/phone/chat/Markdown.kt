package com.hivemind.phone.chat

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle

/**
 * A block of what an agent says, which is markdown, as the chat draws it (design P7): the little
 * of markdown agents write, drawn natively, nothing more. Fenced code is kept as it is.
 */
sealed interface Block {
    data class Text(val text: String) : Block

    data class Heading(val text: String) : Block

    /** A list's item, with its marker: `•`, or its number (`1.`). */
    data class Item(val marker: String, val text: String) : Block

    data class Code(val text: String) : Block
}

private val heading = Regex("""^#{1,6}\s+(.*)$""")
private val item = Regex("""^\s*([-*+]|\d+[.)])\s+(.*)$""")

/** [markdown] cut into blocks: fenced code as it is; headings, list items, and paragraphs between blank lines. */
fun blocks(markdown: String): List<Block> {
    val blocks = mutableListOf<Block>()
    val paragraph = StringBuilder()
    fun paragraphEnds() {
        if (paragraph.isNotBlank()) blocks += Block.Text(paragraph.toString())
        paragraph.clear()
    }
    var code: StringBuilder? = null
    for (line in markdown.lines()) {
        val fence = line.trimStart().startsWith("```")
        val inCode = code
        if (inCode != null) {
            if (fence) {
                blocks += Block.Code(inCode.toString().removeSuffix("\n"))
                code = null
            } else {
                inCode.append(line).append('\n')
            }
            continue
        }
        val headed = heading.matchEntire(line)
        val listed = item.matchEntire(line)
        when {
            fence -> {
                paragraphEnds()
                code = StringBuilder()
            }
            line.isBlank() -> paragraphEnds()
            headed != null -> {
                paragraphEnds()
                blocks += Block.Heading(headed.groupValues[1])
            }
            listed != null -> {
                paragraphEnds()
                val marker = listed.groupValues[1]
                blocks += Block.Item(if (marker[0].isDigit()) marker else "•", listed.groupValues[2])
            }
            else -> {
                if (paragraph.isNotEmpty()) paragraph.append('\n')
                paragraph.append(line)
            }
        }
    }
    // A fence not closed yet: the agent is still saying it.
    code?.let { blocks += Block.Code(it.toString().removeSuffix("\n")) }
    paragraphEnds()
    return blocks
}

/** [text]'s inline marks: `code` and **strong**; anything else as it is written. */
fun inline(text: String, code: SpanStyle, strong: SpanStyle): AnnotatedString = buildAnnotatedString {
    var at = 0
    while (at < text.length) {
        val tick = text.indexOf('`', at)
        val stars = text.indexOf("**", at)
        val next = listOf(tick, stars).filter { it >= 0 }.minOrNull()
        if (next == null) {
            append(text, at, text.length)
            break
        }
        append(text, at, next)
        val (mark, style) = if (next == tick) "`" to code else "**" to strong
        val end = text.indexOf(mark, next + mark.length)
        if (end < 0) {
            // Not closed: the mark is only a character written, and what follows may still be marked.
            append(text, next, next + mark.length)
            at = next + mark.length
            continue
        }
        withStyle(style) { append(text, next + mark.length, end) }
        at = end + mark.length
    }
}

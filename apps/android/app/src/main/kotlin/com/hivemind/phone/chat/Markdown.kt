package com.hivemind.phone.chat

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.hivemind.phone.core.BlockKind
import com.hivemind.phone.core.ColumnAlign
import com.hivemind.phone.core.ListMarker
import com.hivemind.phone.core.TextBlock
import com.hivemind.phone.core.TextRun
import com.hivemind.phone.core.markdown
import com.hivemind.phone.ui.theme.Mono

/**
 * What an agent says, which is markdown, as the core reads it (spec/markdown.md) and drawn here:
 * read once, when the row is first drawn. A link is one only where the core found an https address,
 * and opens it when tapped.
 */
@Composable
fun Markdown(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { markdown(text) }
    Blocks(blocks, quote = 0u, modifier)
}

/** `blocks`, those in a quote deeper than `quote` drawn set in, after a bar. */
@Composable
private fun Blocks(blocks: List<TextBlock>, quote: UInt, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        var i = 0
        while (i < blocks.size) {
            val at = i
            if (blocks[i].quote > quote) {
                while (i < blocks.size && blocks[i].quote > quote) i++
                key(at) { Quote(blocks.subList(at, i), quote + 1u) }
            } else {
                key(at) { Listed(blocks[at]) }
                i++
            }
        }
    }
}

@Composable
private fun Quote(blocks: List<TextBlock>, quote: UInt) {
    val bar = MaterialTheme.colorScheme.outlineVariant
    Blocks(
        blocks,
        quote,
        Modifier
            .drawBehind { drawRect(bar, size = Size(3.dp.toPx(), size.height)) }
            .padding(start = 13.dp),
    )
}

/** In a list, `block` set in by its depth, after its item's marker when it starts one. */
@Composable
private fun Listed(block: TextBlock) {
    if (block.depth == 0u) return Drawn(block)
    val marker = when (val m = block.marker) {
        null -> ""
        ListMarker.Bullet -> "•"
        is ListMarker.Number -> "${m.n}."
        is ListMarker.Task -> if (m.done) "☑" else "☐"
    }
    Row(Modifier.padding(start = 20.dp * (block.depth.toInt() - 1))) {
        Text(marker, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.widthIn(min = 22.dp).padding(end = 6.dp))
        Drawn(block, Modifier.weight(1f))
    }
}

@Composable
private fun Drawn(block: TextBlock, modifier: Modifier = Modifier) {
    val type = MaterialTheme.typography
    val colors = MaterialTheme.colorScheme
    val marks = remember(colors) {
        Marks(
            code = SpanStyle(fontFamily = Mono, background = colors.surfaceContainerHighest),
            link = TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline)),
        )
    }
    when (val kind = block.kind) {
        // Across the row, each from the side its first letter is written from, as the core read it.
        is BlockKind.Paragraph -> Text(remember(kind, marks) { marks.of(kind.runs) }, modifier.fillMaxWidth(), style = type.bodyMedium.copy(textDirection = block.direction))
        is BlockKind.Heading -> Text(
            remember(kind, marks) { marks.of(kind.runs) },
            modifier.fillMaxWidth().semantics { heading() },
            // Larger than the text at every level, the higher the larger.
            style = when (kind.level.toInt()) {
                1 -> type.titleLarge
                2 -> type.titleMedium.copy(fontWeight = FontWeight.SemiBold)
                else -> type.bodyLarge.copy(fontWeight = FontWeight.SemiBold)
            }.copy(textDirection = block.direction),
        )
        is BlockKind.Code -> Surface(
            color = colors.surfaceContainerHighest,
            shape = RoundedCornerShape(8.dp),
            modifier = modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                kind.language?.let { Text(it, style = type.labelSmall, color = colors.onSurfaceVariant) }
                // As written: its lines are not wrapped, it scrolls across instead.
                Text(
                    kind.text,
                    style = type.bodySmall,
                    fontFamily = Mono,
                    softWrap = false,
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                )
            }
        }
        BlockKind.Rule -> HorizontalDivider(modifier.padding(vertical = 4.dp), color = colors.outlineVariant)
        is BlockKind.Table -> Table(kind, marks, type.bodySmall, modifier)
    }
}

private val TextBlock.direction get() = if (rtl) TextDirection.Rtl else TextDirection.Ltr

/** A table's columns side by side, its head's cell over each, scrolled across when wider than the screen. */
@Composable
private fun Table(table: BlockKind.Table, marks: Marks, style: TextStyle, modifier: Modifier) {
    val columns = maxOf(table.head.size, table.rows.maxOfOrNull { it.size } ?: 0)
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        for (c in 0 until columns) {
            val align = when (table.align.getOrNull(c)) {
                ColumnAlign.CENTER -> Alignment.CenterHorizontally
                ColumnAlign.RIGHT -> Alignment.End
                else -> Alignment.Start
            }
            Column(horizontalAlignment = align, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(marks.of(table.head.getOrNull(c).orEmpty()), style = style.copy(fontWeight = FontWeight.SemiBold), softWrap = false)
                for (row in table.rows) Text(marks.of(row.getOrNull(c).orEmpty()), style = style, softWrap = false)
            }
        }
    }
}

/** How runs look: `code`'s style, and a link's. */
private class Marks(val code: SpanStyle, val link: TextLinkStyles) {
    fun of(runs: List<TextRun>): AnnotatedString = buildAnnotatedString {
        for (run in runs) {
            val style = SpanStyle(
                fontWeight = if (run.strong) FontWeight.Bold else null,
                fontStyle = if (run.emphasis) FontStyle.Italic else null,
                textDecoration = if (run.strike) TextDecoration.LineThrough else null,
            ).let { if (run.code) code.merge(it) else it }
            // An image by its words: nothing is fetched to draw it.
            val text = if (run.image) "🖼 ${run.text}" else run.text
            val url = run.link
            if (url == null) {
                withStyle(style) { append(text) }
            } else {
                withLink(LinkAnnotation.Url(url, link)) { withStyle(style) { append(text) } }
            }
        }
    }
}

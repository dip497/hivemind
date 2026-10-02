package com.hivemind.phone.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.Said
import com.hivemind.phone.core.ToolResult
import com.hivemind.phone.ui.common.FollowTheNewest
import com.hivemind.phone.ui.common.NewestButton

/** The ended note's key in the list: a number, which no entry's id (text) equals. */
private const val ENDED = -1

/** How an entry is drawn, so that the list reuses a row only for one drawn alike. */
private enum class Kind { TOOL, RESULT, PERSON, AGENT, ENDED }

private fun kindOf(entry: Entry): Kind = when (entry.said) {
    is Said.ToolUse -> Kind.TOOL
    is Said.ToolOutput -> Kind.RESULT
    is Said.Person -> Kind.PERSON
    is Said.Agent -> Kind.AGENT
}

/** How inline marks look: `code`, and **strong**. */
@Immutable
private class Marks(val code: SpanStyle, val strong: SpanStyle) {
    fun of(text: String): AnnotatedString = inline(text, code, strong)
}

/**
 * What an agent and the person say to each other, as a chat (design P7): the person's words in
 * bubbles, the agent's as light markdown, and each tool it used as one row, what the tool gave back
 * folded under it. An append-only list keyed by entry, following the newest until the person
 * scrolls up, as the terminal does.
 */
@Composable
fun ChatView(chat: Chat, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val marks = remember(colors) {
        Marks(
            code = SpanStyle(fontFamily = FontFamily.Monospace, background = colors.surfaceContainerHighest),
            strong = SpanStyle(fontWeight = FontWeight.Bold),
        )
    }

    FollowTheNewest(chat.follow)

    Box(modifier) {
        LazyColumn(
            state = chat.follow.list,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(chat.entries, key = { it.id }, contentType = ::kindOf) { entry -> EntryRow(entry, chat, marks) }
            chat.ended?.let { why ->
                item(key = ENDED, contentType = Kind.ENDED) {
                    Text(
                        endedNote(why),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        when {
            !chat.heard -> CircularProgressIndicator(Modifier.align(Alignment.Center))
            chat.entries.isEmpty() -> Text(
                stringResource(R.string.chat_nothing),
                color = colors.onSurfaceVariant,
                modifier = Modifier.align(Alignment.Center),
            )
        }
        NewestButton(chat.follow) { chat.last }
    }
}

/** Why the conversation is told no more, in words. */
@Composable
private fun endedNote(why: ConversationEnded): String = when (why) {
    is ConversationEnded.Refused -> stringResource(R.string.chat_ended, why.why)
    ConversationEnded.NotHeld -> stringResource(R.string.chat_ended_not_held)
    ConversationEnded.Unpaired -> stringResource(R.string.chat_ended_unpaired)
}

@Composable
private fun EntryRow(entry: Entry, chat: Chat, marks: Marks) {
    when (val said = entry.said) {
        // Its result is read here, by the row alone: when it comes, this row redraws, not the list.
        is Said.ToolUse -> ToolRow(said.tool.name, said.tool.about, chat.result(said.tool.id))
        // A result whose use was told before what is shown began.
        is Said.ToolOutput -> ToolRow(stringResource(R.string.chat_result), null, said.result)
        is Said.Person -> PersonSaid(said.text)
        is Said.Agent -> AgentSaid(said.text, marks)
    }
}

@Composable
private fun PersonSaid(text: String) {
    Box(Modifier.fillMaxWidth().padding(start = 48.dp), contentAlignment = Alignment.CenterEnd) {
        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp)) {
            Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
        }
    }
}

/** The agent's markdown, cut into blocks and marked once, when the row is first drawn. */
@Composable
private fun AgentSaid(text: String, marks: Marks) {
    val blocks = remember(text) { blocks(text) }
    val marked = remember(text, marks) {
        blocks.map { block ->
            when (block) {
                is Block.Text -> marks.of(block.text)
                is Block.Heading -> marks.of(block.text)
                is Block.Item -> marks.of(block.text)
                is Block.Code -> AnnotatedString(block.text)
            }
        }
    }
    val type = MaterialTheme.typography
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEachIndexed { i, block ->
            when (block) {
                is Block.Text -> Text(marked[i], style = type.bodyMedium)
                is Block.Heading -> Text(marked[i], style = type.titleSmall)
                is Block.Item -> Row {
                    Text(block.marker, style = type.bodyMedium, modifier = Modifier.widthIn(min = 20.dp).padding(end = 6.dp))
                    Text(marked[i], style = type.bodyMedium)
                }
                is Block.Code -> Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHighest,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    // As written: its lines are not wrapped, it scrolls across instead.
                    Text(
                        marked[i],
                        style = type.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        softWrap = false,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(8.dp),
                    )
                }
            }
        }
    }
}

/** A tool used: one row, `name · about`; tapped, what it gave back unfolds under it, red when it failed. */
@Composable
private fun ToolRow(name: String, about: String?, result: ToolResult?) {
    var open by rememberSaveable { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val failed = result?.error == true
    val tint = if (failed) colors.error else colors.onSurfaceVariant
    val label = stringResource(if (open) R.string.chat_hide_result else R.string.chat_show_result)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .clickable(enabled = result != null, onClickLabel = label) { open = !open }
            .padding(vertical = 4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (result == null) {
                Spacer(Modifier.size(18.dp))
            } else {
                Icon(
                    if (open) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(18.dp),
                )
            }
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(name) }
                    if (about != null) {
                        append(" · ")
                        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(about) }
                    }
                },
                style = MaterialTheme.typography.labelLarge,
                color = tint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 4.dp),
            )
        }
        if (open && result != null) {
            Text(
                result.text,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = if (failed) colors.error else colors.onSurface,
                modifier = Modifier.padding(start = 22.dp, top = 4.dp),
            )
        }
    }
}

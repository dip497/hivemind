package com.hivemind.phone.chat

import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.ConversationEnded
import com.hivemind.phone.core.Entry
import com.hivemind.phone.core.Said
import com.hivemind.phone.core.ToolResult
import com.hivemind.phone.ui.common.FollowTheNewest
import com.hivemind.phone.ui.common.NewestButton
import com.hivemind.phone.ui.theme.Mono

/** The ended note's key in the list, and the end's: numbers, which no entry's id (text) equals. */
private const val ENDED = -1
private const val END = -2

/** How an entry is drawn, so that the list reuses a row only for one drawn alike. */
private enum class Kind { TOOL, RESULT, PERSON, AGENT, TOOLS, ENDED, END }

private fun kindOf(shown: Shown): Kind = when (shown) {
    is Shown.Tools -> Kind.TOOLS
    is Shown.One -> when (shown.entry.said) {
        is Said.ToolUse -> Kind.TOOL
        is Said.ToolOutput -> Kind.RESULT
        is Said.Person -> Kind.PERSON
        is Said.Agent -> Kind.AGENT
    }
}

/** Whether [shown] is the person's, so that a turn begins where who speaks changes. */
private fun Shown.person() = this is Shown.One && entry.said is Said.Person

/**
 * What an agent and the person say to each other, as a chat (design P7): the person's words in
 * bubbles, the agent's as light markdown, and each tool it used as one row that opens the use,
 * [onTool], by its entry's id. The newest is at the bottom, drawn from there up, so a keyboard that
 * opens takes room from the top and leaves what the person reads where it is; the list follows the
 * newest until the person scrolls up. [end], while [endKey] is not null, is the last thing in it:
 * what the agent waits on, where it stopped.
 */
@Composable
fun ChatView(
    chat: Chat,
    onTool: (String) -> Unit,
    modifier: Modifier = Modifier,
    endKey: Any? = null,
    end: @Composable () -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme

    FollowTheNewest(chat.follow)
    LaunchedEffect(endKey) { if (endKey != null) chat.follow.grew(0) }

    Box(modifier) {
        LazyColumn(
            state = chat.follow.list,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            // 8 between what one says, 20 where the other begins (design PB §12.12).
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.Bottom),
        ) {
            if (endKey != null) item(key = END, contentType = Kind.END) { end() }
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
            val shown = chat.shown
            items(shown.size, key = { shown[shown.size - 1 - it].key }, contentType = { kindOf(shown[shown.size - 1 - it]) }) { i ->
                val at = shown.size - 1 - i
                val turn = at > 0 && shown[at].person() != shown[at - 1].person()
                Box(if (turn) Modifier.padding(top = 12.dp) else Modifier) {
                    when (val item = shown[at]) {
                        is Shown.One -> EntryRow(item.entry, chat, onTool)
                        is Shown.Tools -> ToolsRow(item, chat, onTool)
                    }
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
        NewestButton(chat.follow) { 0 }
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
private fun EntryRow(entry: Entry, chat: Chat, onTool: (String) -> Unit) {
    when (val said = entry.said) {
        // Its result is read here, by the row alone: when it comes, this row redraws, not the list.
        is Said.ToolUse -> ToolRow(said.tool.name, said.tool.about, chat.result(said.tool.id)) { onTool(entry.id) }
        // A result whose use was told before what is shown began.
        is Said.ToolOutput -> ToolRow(stringResource(R.string.chat_result), null, said.result) { onTool(entry.id) }
        // Held down, what is said is selected, to copy.
        is Said.Person -> PersonSaid(said.text)
        is Said.Agent -> SelectionContainer { Markdown(said.text) }
    }
}

/** Tools used one after another, folded: one row counting each ("Read 3 · Edit 2 · 1 failed"), that opens to them in order. */
@Composable
private fun ToolsRow(tools: Shown.Tools, chat: Chat, onTool: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val open = chat.opened[tools.key] == true
    val summary = chat.summary(tools.entries, stringResource(R.string.chat_result))
    val state = stringResource(if (open) R.string.fold_open else R.string.fold_folded)
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.extraSmall)
                .clickable(role = Role.Button) { chat.opened[tools.key] = !open }
                .semantics { stateDescription = state }
                .padding(vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(summary.counts, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (summary.failed > 0) {
                Text(
                    stringResource(R.string.tools_failed, summary.failed),
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.error,
                    maxLines = 1,
                    modifier = Modifier.padding(start = 6.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            Icon(
                if (open) Icons.Filled.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = colors.tertiary,
                modifier = Modifier.size(18.dp),
            )
        }
        if (open) {
            Column(Modifier.padding(start = 12.dp)) {
                for (entry in tools.entries) EntryRow(entry, chat, onTool)
            }
        }
    }
}

@Composable
private fun PersonSaid(text: String) {
    Box(Modifier.fillMaxWidth().padding(start = 48.dp), contentAlignment = Alignment.CenterEnd) {
        Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = RoundedCornerShape(18.dp)) {
            SelectionContainer {
                Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    }
}

/** A tool used: one line, its name and what it is about, a long path cut in the middle; red when it failed. */
@Composable
private fun ToolRow(name: String, about: String?, result: ToolResult?, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val tint = if (result?.error == true) colors.error else colors.onSurfaceVariant
    Row(
        Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.extraSmall)
            .clickable(onClickLabel = stringResource(R.string.tool_open), onClick = onOpen)
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(verb(name), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Medium, color = tint, maxLines = 1)
        if (about != null) {
            Text(
                about,
                style = MaterialTheme.typography.labelMedium,
                fontFamily = Mono,
                color = if (result?.error == true) colors.error else colors.tertiary,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.padding(start = 8.dp).weight(1f),
            )
        } else {
            Spacer(Modifier.weight(1f))
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = colors.tertiary,
            modifier = Modifier.size(18.dp),
        )
    }
}

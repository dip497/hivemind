package com.hivemind.phone.ui.needs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Device
import com.hivemind.phone.ui.common.AnswerControls
import com.hivemind.phone.ui.common.Dot
import com.hivemind.phone.ui.common.RaisedCard
import com.hivemind.phone.ui.common.asked
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.theme.LocalStateColors

/**
 * What waits on the person, the longest first (design §6.2), as items of Home's list: each a card
 * with why it waits and for how long, its agent and where it runs, what it asks and its answers;
 * and the devices away or still asked, without which that nothing waits is not known.
 */
fun LazyListScope.needsItems(
    state: NeedsState,
    busy: Set<Any>,
    now: Long,
    onOpen: (AgentRef) -> Unit,
    onAnswer: (Agent, Answer) -> Unit,
) {
    val card = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
    val note = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
    items(state.away, key = { "away:${it.id}" }) { device -> AwayNote(device, now, note) }
    items(state.asking, key = { "asking:${it.id}" }) { device -> AskingNote(device, note) }
    // Nothing waits only once every device not away has said so.
    if (state.needs.isEmpty() && state.asking.isEmpty()) {
        item(key = "none") {
            Text(
                if (state.working == 0) {
                    stringResource(R.string.needs_none)
                } else {
                    pluralStringResource(R.plurals.needs_none_working, state.working, state.working)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            )
        }
    }
    items(state.needs, key = { "need:${it.at.device}/${it.at.workspace}/${it.at.tile}" }) { agent ->
        NeedRow(agent, state.lastHeard(agent), agent.at in busy, now, onOpen, onAnswer, card)
    }
}

@Composable
private fun AskingNote(device: Device, modifier: Modifier) {
    Text(
        stringResource(R.string.needs_asking, device.name),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.tertiary,
        modifier = modifier,
    )
}

@Composable
private fun AwayNote(device: Device, now: Long, modifier: Modifier) {
    val heard = device.heardAt
    Text(
        if (heard == null) {
            stringResource(R.string.needs_away, device.name)
        } else {
            stringResource(R.string.needs_away_heard, device.name, sinceText(heard, now))
        },
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.tertiary,
        modifier = modifier,
    )
}

@Composable
private fun NeedRow(
    agent: Agent,
    lastHeard: Boolean,
    busy: Boolean,
    now: Long,
    onOpen: (AgentRef) -> Unit,
    onAnswer: (Agent, Answer) -> Unit,
    modifier: Modifier,
) {
    val waiting = agent.waiting ?: return
    RaisedCard(modifier, onClick = { onOpen(agent.at) }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(LocalStateColors.current.waiting)
                Text(
                    if (lastHeard) stringResource(R.string.needs_as_last_heard, waiting.kind.asked()) else waiting.kind.asked(),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f).padding(start = 8.dp),
                )
                Text(
                    sinceText(waiting.since, now),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                )
            }
            Column {
                Text(
                    agent.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    stringResource(R.string.where, agent.workspaceName, agent.machine),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            AnswerControls(waiting, busy, onAnswer = { onAnswer(agent, it) })
        }
    }
}

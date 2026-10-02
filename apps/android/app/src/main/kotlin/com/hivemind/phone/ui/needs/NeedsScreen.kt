package com.hivemind.phone.ui.needs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.theme.LocalStateColors

/**
 * What waits on the person, the longest first (design §6.2): each with its agent, where it runs,
 * why it waits and for how long, and its answers on the row.
 */
@Composable
fun NeedsList(
    state: NeedsState,
    busy: Set<Any>,
    now: Long,
    onOpen: (AgentRef) -> Unit,
    onAnswer: (Agent, Answer) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(state.away, key = { "away:${it.id}" }) { device -> AwayNote(device, now) }
        if (state.needs.isEmpty()) {
            item(key = "none") {
                Text(
                    if (state.working == 0) {
                        stringResource(R.string.needs_none)
                    } else {
                        pluralStringResource(R.plurals.needs_none_working, state.working, state.working)
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
            }
        }
        items(state.needs, key = { "${it.at.device}/${it.at.workspace}/${it.at.tile}" }) { agent ->
            NeedRow(agent, state.lastHeard(agent), agent.at in busy, now, onOpen, onAnswer)
        }
    }
}

@Composable
private fun AwayNote(device: Device, now: Long) {
    val heard = device.heardAt
    Text(
        if (heard == null) {
            stringResource(R.string.needs_away, device.name)
        } else {
            stringResource(R.string.needs_away_heard, device.name, sinceText(heard, now))
        },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
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
) {
    val waiting = agent.waiting ?: return
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().clickable { onOpen(agent.at) },
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    agent.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    sinceText(waiting.since, now),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                stringResource(R.string.where, agent.workspaceName, agent.machine),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                if (lastHeard) stringResource(R.string.needs_as_last_heard, waiting.kind.label()) else waiting.kind.label(),
                style = MaterialTheme.typography.labelLarge,
                color = LocalStateColors.current.waiting,
            )
            AnswerControls(waiting, busy, onAnswer = { onAnswer(agent, it) })
        }
    }
}

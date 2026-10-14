package com.hivemind.phone.ui.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.ui.common.color
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.common.stoppable
import kotlinx.coroutines.launch

/**
 * The agents of the devices whose Home has not come yet (design §6.3), as items of Home's list: by
 * device and workspace, each row as [AgentRow] draws it.
 */
fun LazyListScope.agentsItems(
    state: AgentsState,
    busy: Set<Any>,
    now: Long,
    onOpen: (AgentRef) -> Unit,
    onStop: (Agent) -> Unit,
    onClose: (Agent) -> Unit,
) {
    for (device in state.devices) {
        item(key = "device:${device.id}") {
            Text(
                if (device.reachable) device.name else stringResource(R.string.agents_device_away, device.name),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 4.dp),
            )
        }
        for (workspace in device.workspaces) {
            item(key = "workspace:${device.id}/${workspace.id}") {
                Text(
                    workspace.name,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            items(workspace.agents, key = { "agent:${it.at.device}/${it.at.workspace}/${it.at.tile}" }) { agent ->
                AgentRow(agent, agent.at in busy, now, onOpen, onStop, onClose)
            }
        }
    }
}

/**
 * An agent's row: its state, its name, what it [says] (else its state and program), for how long,
 * set in by [depth]. Swiped right it stops its turn (when it works and can be interrupted); left it
 * closes.
 */
@Composable
fun AgentRow(
    agent: Agent,
    busy: Boolean,
    now: Long,
    onOpen: (AgentRef) -> Unit,
    onStop: (Agent) -> Unit,
    onClose: (Agent) -> Unit,
    says: String? = null,
    depth: Int = 0,
) {
    val swipe = rememberSwipeToDismissBoxState()
    val scope = rememberCoroutineScope()
    SwipeToDismissBox(
        state = swipe,
        enableDismissFromStartToEnd = agent.stoppable && !busy,
        enableDismissFromEndToStart = !busy,
        // An action, not a removal: the row springs back, and the overview says what became of it.
        onDismiss = { direction ->
            when (direction) {
                SwipeToDismissBoxValue.StartToEnd -> onStop(agent)
                SwipeToDismissBoxValue.EndToStart -> onClose(agent)
                SwipeToDismissBoxValue.Settled -> Unit
            }
            scope.launch { swipe.reset() }
        },
        backgroundContent = {
            val toStop = swipe.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            Box(
                Modifier
                    .fillMaxSize()
                    .background(if (toStop) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.errorContainer)
                    .padding(horizontal = 20.dp),
                contentAlignment = if (toStop) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                Text(stringResource(if (toStop) R.string.action_stop else R.string.action_close))
            }
        },
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surface)
                .clickable { onOpen(agent.at) }
                .padding(start = 16.dp + 12.dp * depth, end = 16.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(10.dp).background(agent.state.color(), CircleShape))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(agent.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    says ?: listOfNotNull(agent.state.label(), agent.program?.label).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (says == null || agent.state == AgentState.WAITING) agent.state.color() else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            agent.since?.let {
                Text(
                    sinceText(it, now),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

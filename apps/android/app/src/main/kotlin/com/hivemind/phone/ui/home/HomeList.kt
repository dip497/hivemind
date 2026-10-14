package com.hivemind.phone.ui.home

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.graphics.toColorInt
import com.hivemind.phone.R
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.HomeEntry
import com.hivemind.phone.core.HomeTile
import com.hivemind.phone.ui.agents.AgentRow
import com.hivemind.phone.ui.agents.agentsItems
import com.hivemind.phone.ui.common.GroupLabel
import com.hivemind.phone.ui.common.PillChip
import com.hivemind.phone.ui.common.StateMark
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.needs.needsItems
import com.hivemind.phone.ui.theme.Mono

/**
 * Home, as the desktop's Layers panel lists it (spec/home.md, design B5 §11.2): a search while
 * [searching] and, with more than one machine, All and a chip for each; what waits on the person, with its answers; what is at
 * work; the pinned; then each machine's projects, frames and tiles, each tile with what it last
 * said. An agent's row opens it, and swiped stops or closes it; a project's + starts an agent.
 */
@Composable
fun HomeList(
    state: HomeState,
    busy: Set<Any>,
    now: Long,
    onSearch: (String) -> Unit,
    onMachine: (String) -> Unit,
    onOpen: (AgentRef) -> Unit,
    onAnswer: (Agent, Answer) -> Unit,
    onStop: (Agent) -> Unit,
    onClose: (Agent) -> Unit,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
    searching: Boolean = true,
) {
    val machines = state.homes.flatMap { it.machines }.distinct()
    val rows = Rows(state, busy, now, onOpen, onStop, onClose, onStart)
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
        if (searching || state.filter.query.isNotEmpty()) {
            item(key = "search") { SearchField(state.filter.query, onSearch) }
        }
        if (machines.isNotEmpty()) {
            item(key = "machines") {
                val chosen = state.filter.machine
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item(key = "all") {
                        // The chosen machine, chosen again, shows every machine.
                        PillChip(chosen == null, onClick = { chosen?.let(onMachine) }, label = stringResource(R.string.home_all_machines))
                    }
                    items(machines, key = { it }) { machine ->
                        PillChip(machine == chosen, onClick = { onMachine(machine) }, label = machine)
                    }
                }
            }
        }
        needsItems(state.needs, state.tiles, busy, now, onOpen, onAnswer)
        val working = state.homes.flatMap { home -> home.working.map { home.device to it } }
        if (working.isNotEmpty()) {
            item(key = "working") { Heading(stringResource(R.string.home_working)) }
            with(rows) { entries("working", working) }
        }
        val pinned = state.homes.flatMap { home -> home.pinned.map { home.device to it } }
        if (pinned.isNotEmpty()) {
            item(key = "pinned") { Heading(stringResource(R.string.home_pinned)) }
            with(rows) { entries("pinned", pinned) }
        }
        with(rows) { entries("tree", state.homes.flatMap { home -> home.tree.map { home.device to it } }) }
        agentsItems(state.elsewhere, busy, now, onOpen, onStop, onClose)
        if (pinned.isEmpty() && state.homes.all { it.tree.isEmpty() } && state.elsewhere.devices.isEmpty()) {
            item(key = "nothing") {
                val searched = state.filter.query.isNotEmpty() || state.filter.machine != null
                Text(
                    stringResource(if (searched) R.string.home_no_match else R.string.home_nothing),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
    }
}

/** How Home draws each line of its lists. */
private class Rows(
    val state: HomeState,
    val busy: Set<Any>,
    val now: Long,
    val onOpen: (AgentRef) -> Unit,
    val onStop: (Agent) -> Unit,
    val onClose: (Agent) -> Unit,
    val onStart: () -> Unit,
) {
    /** [entries] of the list [list], each by the computer it is on: a tile is in more than one list. */
    fun LazyListScope.entries(list: String, entries: List<Pair<String, HomeEntry>>) {
        items(entries, key = { (device, entry) -> "$list:$device:${entry.key}" }) { (_, entry) -> Entry(entry) }
    }

    @Composable
    fun Entry(entry: HomeEntry) {
        when (entry) {
            is HomeEntry.Machine -> Text(
                entry.name,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 4.dp),
            )
            is HomeEntry.Project -> Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    entry.name,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onStart) {
                    Icon(
                        Icons.Filled.Add,
                        stringResource(R.string.home_start_in, entry.name),
                        tint = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }
            is HomeEntry.Frame -> Row(
                Modifier.fillMaxWidth().padding(start = 16.dp + 12.dp * entry.depth.toInt(), end = 16.dp, top = 8.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).background(swatch(entry.color), RoundedCornerShape(2.dp)))
                Spacer(Modifier.width(10.dp))
                Text(
                    entry.title,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                entry.folder?.let {
                    Spacer(Modifier.width(8.dp))
                    Text(it, style = MaterialTheme.typography.labelMedium, fontFamily = Mono, color = MaterialTheme.colorScheme.tertiary, maxLines = 1)
                }
            }
            is HomeEntry.Tile -> Tile(entry.tile, entry.depth.toInt())
        }
    }

    @Composable
    private fun Tile(tile: HomeTile, depth: Int) {
        val agent = state.agents[tile.at]
        if (agent != null) {
            AgentRow(agent, agent.at in busy, now, onOpen, onStop, onClose, says = tile.says(), depth = depth)
            return
        }
        // Not an agent the overview lists: what it is, and what it last showed.
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp + 12.dp * depth, end = 16.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(tile.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    tile.says() ?: tile.state?.label() ?: tile.kind,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            tile.since?.let {
                Text(
                    sinceText(it, now),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(start = 12.dp),
                )
            }
            Box(Modifier.padding(start = 10.dp).size(12.dp), contentAlignment = Alignment.Center) { StateMark(tile.state) }
        }
    }
}

/** What names a line in every list it is in. */
private val HomeEntry.key: String
    get() = when (this) {
        is HomeEntry.Machine -> key
        is HomeEntry.Project -> key
        is HomeEntry.Frame -> key
        is HomeEntry.Tile -> key
    }

@Composable
private fun Heading(text: String) = GroupLabel(text, Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 2.dp))

/** The search, a pill on a raised ground. */
@Composable
private fun SearchField(query: String, onSearch: (String) -> Unit) {
    val colors = MaterialTheme.colorScheme
    TextField(
        value = query,
        onValueChange = onSearch,
        placeholder = { Text(stringResource(R.string.home_search)) },
        leadingIcon = { Icon(Icons.Filled.Search, null, tint = colors.tertiary) },
        singleLine = true,
        shape = CircleShape,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = colors.surfaceContainer,
            unfocusedContainerColor = colors.surfaceContainer,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            unfocusedPlaceholderColor = colors.tertiary,
            focusedPlaceholderColor = colors.tertiary,
        ),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

/**
 * What a tile's row says under its name: what it waits on (its tool and command, or its question),
 * else what it last said; none leaves the row to say its state.
 */
@Composable
private fun HomeTile.says(): String? {
    val tool = tool
    return when {
        tool != null -> about?.let { "$tool: $it" } ?: tool
        question != null -> question
        waits != null -> waits?.label()
        else -> line
    }
}

/** A frame's colour as the desktop gives it (`#rrggbb`), else the outline's. */
@Composable
private fun swatch(color: String): Color =
    runCatching { Color(color.toColorInt()) }.getOrDefault(MaterialTheme.colorScheme.tertiary)

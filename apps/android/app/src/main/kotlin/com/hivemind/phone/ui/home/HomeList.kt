package com.hivemind.phone.ui.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.toColorInt
import com.hivemind.phone.R
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.HomeEntry
import com.hivemind.phone.core.HomeTile
import com.hivemind.phone.ui.agents.AgentSwipe
import com.hivemind.phone.ui.agents.agentsItems
import com.hivemind.phone.ui.common.GroupLabel
import com.hivemind.phone.ui.common.LineIcons
import com.hivemind.phone.ui.common.PillChip
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.needs.needsItems
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.Mono

/**
 * Home, as the desktop's Layers panel lists it (spec/home.md, design B5 §11.2): a search while
 * [searching] and, with more than one machine, All and a chip for each; what waits on the person, with its answers; what is at
 * work; the pinned; then each machine's projects, frames and tiles, or the sections the View menu
 * groups them in, each tile with its mark and what it last said. An agent's row opens it, and
 * swiped stops or closes it; a project, frame or section tapped folds ([onFold], by its key); a
 * project's + starts an agent.
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
    onFold: (String) -> Unit = {},
) {
    val machines = state.homes.flatMap { it.machines }.distinct()
    val marks = remember { MarkCache() }
    val rows = Rows(state, busy, now, marks, onOpen, onStop, onClose, onStart, onFold)
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
        needsItems(state.needs, busy, now, onOpen, onAnswer)
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
    val marks: MarkCache,
    val onOpen: (AgentRef) -> Unit,
    val onStop: (Agent) -> Unit,
    val onClose: (Agent) -> Unit,
    val onStart: () -> Unit,
    val onFold: (String) -> Unit,
) {
    private val marksOf = state.homes.associate { it.device to it.marks }

    /** [entries] of the list [list], each by the computer it is on: a tile is in more than one list. */
    fun LazyListScope.entries(list: String, entries: List<Pair<String, HomeEntry>>) {
        items(entries, key = { (device, entry) -> "$list:$device:${entry.key}" }) { (device, entry) -> Entry(device, entry) }
    }

    @Composable
    fun Entry(device: String, entry: HomeEntry) {
        when (entry) {
            is HomeEntry.Machine -> Text(
                entry.name,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 4.dp),
            )
            is HomeEntry.Project -> Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .clickable { onFold(entry.key) }
                    .padding(start = START, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FoldArrow(entry.folded, entry.name)
                Spacer(Modifier.width(8.dp))
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        entry.name,
                        style = MaterialTheme.typography.titleSmall,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    StateBadge(entry.state)
                }
                Count(entry.count)
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
                Modifier
                    .fillMaxWidth()
                    .clickable { onFold(entry.key) }
                    .rails(entry.depth.toInt())
                    .padding(start = indent(entry.depth.toInt()), end = 16.dp)
                    .heightIn(min = 40.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FoldArrow(entry.folded, entry.title)
                Spacer(Modifier.width(4.dp))
                FolderMark(entry.color, entry.worktree, entry.folded)
                Spacer(Modifier.width(8.dp))
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        entry.title,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    (if (entry.worktree) entry.branch ?: entry.folder else entry.folder)?.let {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            it,
                            style = MaterialTheme.typography.labelMedium,
                            fontFamily = Mono,
                            color = MaterialTheme.colorScheme.tertiary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                    StateBadge(entry.state)
                }
                Count(entry.count)
            }
            is HomeEntry.Section -> if (entry.label.isEmpty()) {
                Spacer(Modifier.height(4.dp))
            } else {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp)
                        .clickable { onFold(entry.key) }
                        .padding(start = START, end = 16.dp)
                        .heightIn(min = 36.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FoldArrow(entry.folded, entry.label)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        entry.label.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        letterSpacing = 0.8.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                    // Its label may already name the state: a dot says it without saying it twice.
                    StateBadge(entry.state, pill = false)
                    Spacer(Modifier.weight(1f))
                    Count(entry.count)
                }
            }
            is HomeEntry.Tile -> Tile(device, entry.tile, entry.depth.toInt())
        }
    }

    /**
     * A tile's row, as a conversation list draws one: its mark in a circle with its state on the
     * corner; its name, and under it what it waits on or last said; how long ago, and a pill when it
     * needs the person or a dot when it finished since they last looked. An agent's opens it and
     * swipes as [AgentSwipe] says.
     */
    @Composable
    private fun Tile(device: String, tile: HomeTile, depth: Int) {
        val agent = state.agents[tile.at]
        val agentState = agent?.state ?: tile.state
        val says = tile.says() ?: agent?.let { listOfNotNull(it.state.label(), it.program?.label).joinToString(" · ") } ?: tile.state?.label()
        val since = agent?.since ?: tile.since
        val mark = tile.runs?.let { runs -> marksOf[device]?.get(runs)?.let { marks.of(runs, it) } }
        val row = @Composable {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.background)
                    .then(if (agent != null) Modifier.clickable { onOpen(agent.at) } else Modifier)
                    .rails(depth)
                    .padding(start = indent(depth), end = 16.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TileMark(mark, tile.agent || tile.terminal, agentState)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            tile.name,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        since?.let {
                            Text(
                                sinceText(it, now),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.tertiary,
                                modifier = Modifier.padding(start = 12.dp),
                            )
                        }
                    }
                    val waiting = agentState == AgentState.WAITING
                    if (says != null || waiting || tile.unread) {
                        Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                says.orEmpty(),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            when {
                                waiting -> NeedsPill(Modifier.padding(start = 8.dp))
                                tile.unread -> UnreadDot(Modifier.padding(start = 8.dp))
                            }
                        }
                    }
                }
            }
        }
        if (agent != null) AgentSwipe(agent, agent.at in busy, onStop, onClose, row) else row()
    }
}

/** Where a row [depth] levels in starts. */
private fun indent(depth: Int): Dp = START + STEP * depth

private val START = 16.dp
private val STEP = 16.dp

/** A thin line down each level a row is in, under the fold arrow of the row it is in. */
@Composable
private fun Modifier.rails(depth: Int): Modifier {
    if (depth <= 0) return this
    val color = MaterialTheme.colorScheme.outlineVariant
    return drawBehind {
        for (level in 0 until depth) {
            val x = (indent(level) + ARROW / 2).toPx()
            drawLine(color, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
        }
    }
}

private val ARROW = 18.dp

/** The arrow that folds what is under a row, or shows it again. */
@Composable
private fun FoldArrow(folded: Boolean, name: String) {
    Icon(
        if (folded) LineIcons.ChevronRight else LineIcons.ChevronDown,
        stringResource(if (folded) R.string.home_unfold else R.string.home_fold, name),
        tint = MaterialTheme.colorScheme.tertiary,
        modifier = Modifier.size(ARROW).padding(2.dp),
    )
}

/** A frame's folder, open or folded, or a branch for a worktree, in its colour turned down. */
@Composable
private fun FolderMark(color: String, worktree: Boolean, folded: Boolean) {
    val frame = swatch(color)
    val muted = lerp(MaterialTheme.colorScheme.tertiary, frame, 0.62f)
    Box(Modifier.size(18.dp)) {
        if (worktree) {
            Icon(LineIcons.GitBranch, null, tint = muted)
        } else {
            Icon(if (folded) LineIcons.FolderFill else LineIcons.FolderOpenFill, null, tint = frame.copy(alpha = 0.22f))
            Icon(if (folded) LineIcons.Folder else LineIcons.FolderOpen, null, tint = muted)
        }
    }
}

/** How many rows are one level under a heading. */
@Composable
private fun Count(count: UInt) {
    if (count == 0u) return
    Text(
        count.toString(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.tertiary,
        modifier = Modifier.padding(start = 8.dp),
    )
}

/** What among a heading's tiles most wants a look: a pill when one needs the person ([pill]), else a dot. */
@Composable
private fun StateBadge(state: AgentState?, pill: Boolean = true) {
    when (state) {
        AgentState.WAITING if pill -> NeedsPill(Modifier.padding(start = 8.dp))
        null -> Unit
        else -> stateColor(state)?.let { Box(Modifier.padding(start = 8.dp).size(6.dp).background(it, CircleShape)) }
    }
}

@Composable
private fun NeedsPill(modifier: Modifier = Modifier) {
    val color = LocalStateColors.current.waiting
    Text(
        stringResource(R.string.home_needs_you),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        color = color,
        maxLines = 1,
        modifier = modifier.background(color.copy(alpha = 0.16f), CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

@Composable
private fun UnreadDot(modifier: Modifier = Modifier) {
    val description = stringResource(R.string.home_unread)
    Box(
        modifier
            .size(8.dp)
            .background(LocalStateColors.current.unread, CircleShape)
            .semantics { contentDescription = description },
    )
}

/** The dot a state puts on a mark's corner: none for a tile at rest. */
@Composable
private fun stateColor(state: AgentState?): Color? {
    val colors = LocalStateColors.current
    return when (state) {
        AgentState.WORKING -> colors.working
        AgentState.WAITING -> colors.waiting
        AgentState.FAILED, AgentState.LIMITED -> colors.failed
        else -> null
    }
}

/**
 * A tile's mark in a circle: its agent's own when the computer sent one, else a terminal for one
 * that runs a terminal and a window for any other kind; its state as a dot on the corner.
 */
@Composable
private fun TileMark(mark: MarkPaths?, runsTerminal: Boolean, state: AgentState?) {
    val colors = MaterialTheme.colorScheme
    Box(Modifier.size(MARK)) {
        Box(Modifier.matchParentSize().background(colors.surfaceContainerHigh, CircleShape), contentAlignment = Alignment.Center) {
            if (mark != null) {
                val ink = colors.onSurface
                Canvas(Modifier.size(22.dp)) { drawMark(mark, ink, size.minDimension) }
            } else {
                Icon(if (runsTerminal) LineIcons.Terminal else LineIcons.Window, null, tint = colors.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
        }
        stateColor(state)?.let { dot ->
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .size(14.dp)
                    .background(colors.background, CircleShape)
                    .padding(2.dp)
                    .background(dot, CircleShape),
            )
        }
    }
}

private val MARK = 40.dp

/** What names a line in every list it is in. */
private val HomeEntry.key: String
    get() = when (this) {
        is HomeEntry.Machine -> key
        is HomeEntry.Project -> key
        is HomeEntry.Frame -> key
        is HomeEntry.Section -> key
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

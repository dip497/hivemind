package com.hivemind.phone.ui.common

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.ui.theme.LocalStateColors

/** A line as thin as the screen draws: between parts of a card, or under a bar. */
@Composable
fun Hairline(modifier: Modifier = Modifier) = HorizontalDivider(modifier, thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)

/** A card raised off the page: what waits on the person, the composer, a prompt. */
@Composable
fun RaisedCard(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val color = MaterialTheme.colorScheme.surfaceContainer
    val shape = MaterialTheme.shapes.medium
    val border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
    if (onClick == null) {
        Surface(modifier.fillMaxWidth(), shape = shape, color = color, border = border) { Column(content = content) }
    } else {
        Surface(onClick, modifier.fillMaxWidth(), shape = shape, color = color, border = border) { Column(content = content) }
    }
}

/** A small grey label over a group: Working, Pinned, Device. */
@Composable
fun GroupLabel(text: String, modifier: Modifier = Modifier) = Text(
    text,
    style = MaterialTheme.typography.labelMedium,
    color = MaterialTheme.colorScheme.tertiary,
    modifier = modifier,
)

/** A round dot: filled, or a ring of [color] when not. */
@Composable
fun Dot(color: Color, filled: Boolean = true, modifier: Modifier = Modifier) {
    val dot = modifier.size(8.dp)
    Box(if (filled) dot.background(color, CircleShape) else dot.border(1.5.dp, color, CircleShape))
}

/**
 * An agent's state as a row's trailing mark: a spinner while it works, an amber dot while it waits
 * on the person, a red one once it failed; nothing when it is idle or done.
 */
@Composable
fun StateMark(state: AgentState?, modifier: Modifier = Modifier) {
    val colors = LocalStateColors.current
    when (state) {
        AgentState.WORKING -> CircularProgressIndicator(
            modifier = modifier.size(12.dp),
            strokeWidth = 1.5.dp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            trackColor = Color.Transparent,
        )
        AgentState.WAITING -> Dot(colors.waiting, modifier = modifier)
        AgentState.FAILED, AgentState.LIMITED -> Dot(colors.failed, modifier = modifier)
        else -> Unit
    }
}

/** A pill to choose by: the chosen one filled, the rest outlined by a hairline. */
@Composable
fun PillChip(selected: Boolean, onClick: () -> Unit, label: String, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null) {
    val colors = MaterialTheme.colorScheme
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, style = MaterialTheme.typography.labelLarge) },
        leadingIcon = leading,
        shape = CircleShape,
        colors = FilterChipDefaults.filterChipColors(
            containerColor = colors.background,
            labelColor = colors.onSurfaceVariant,
            selectedContainerColor = colors.surfaceContainerHigh,
            selectedLabelColor = colors.onSurface,
        ),
        border = FilterChipDefaults.filterChipBorder(
            enabled = true,
            selected = selected,
            borderColor = colors.outlineVariant,
            selectedBorderColor = colors.surfaceContainerHigh,
        ),
        modifier = modifier.height(32.dp),
    )
}

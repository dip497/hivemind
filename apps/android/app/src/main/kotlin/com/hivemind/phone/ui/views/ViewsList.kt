package com.hivemind.phone.ui.views

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R

/**
 * The community views the person's computers offer the phone (design §6, screen 9): each by its
 * name, with its workspace and computer under it; a computer away, its rows dimmed, saying so, and
 * not opened. Pulled down, asked for again. The index of what the app offers (Apple's 4.7.4; the
 * iOS app's says the same).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewsList(
    rows: List<ViewRow>,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onOpen: (ViewRow) -> Unit,
    modifier: Modifier = Modifier,
) {
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (rows.isEmpty()) {
                item(key = "none") {
                    Text(
                        stringResource(R.string.views_none),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }
            items(rows, key = { "${it.place.device}/${it.place.workspace}/${it.view.id}" }) { row ->
                val computer = if (row.away) stringResource(R.string.needs_away, row.place.deviceName) else row.place.deviceName
                ListItem(
                    headlineContent = { Text(row.view.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = {
                        Text(stringResource(R.string.where, row.place.workspaceName, computer), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    modifier = Modifier
                        .clickable(enabled = !row.away) { onOpen(row) }
                        .alpha(if (row.away) 0.5f else 1f),
                )
            }
        }
    }
}

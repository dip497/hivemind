package com.hivemind.phone.ui.diff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.DiffFile
import com.hivemind.phone.ui.theme.LocalStateColors

/** The files an agent changed, with their counts; a file opens to its diff (design §6.5). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiffScreen(vm: DiffViewModel, onBack: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.diff_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
                actions = { TextButton(onClick = vm::load) { Text(stringResource(R.string.action_refresh)) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (val state = vm.state) {
                DiffState.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                is DiffState.Failed -> Text(state.message, Modifier.padding(16.dp))
                is DiffState.Loaded -> DiffFiles(state)
            }
        }
    }
}

@Composable
private fun DiffFiles(state: DiffState.Loaded) {
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    LazyColumn(Modifier.fillMaxSize()) {
        if (state.diff.files.isEmpty()) {
            item { Text(stringResource(R.string.diff_none), Modifier.padding(16.dp)) }
        }
        if (state.diff.truncated) {
            item {
                Text(
                    stringResource(R.string.diff_truncated),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
        }
        for (file in state.diff.files) {
            item(key = file.path) {
                FileRow(file, onClick = { open = if (open == file.path) null else file.path })
            }
            if (open == file.path) {
                // The open file's lines are items of their own: a long patch is laid out as it scrolls.
                val lines = state.patches[file.path]?.lines()
                if (lines == null) {
                    item(key = "${file.path}:none") {
                        Text(
                            stringResource(R.string.diff_no_patch),
                            Modifier.padding(16.dp),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                } else {
                    items(lines.size, key = { "${file.path}:$it" }) { PatchLine(lines[it]) }
                }
            }
        }
    }
}

@Composable
private fun FileRow(file: DiffFile, onClick: () -> Unit) {
    val colors = LocalStateColors.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(file.status, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            file.path,
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.StartEllipsis,
            modifier = Modifier.weight(1f),
        )
        Text("+${file.added}", color = colors.done, style = MaterialTheme.typography.labelMedium)
        Text("−${file.removed}", color = colors.failed, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun PatchLine(line: String) {
    val colors = LocalStateColors.current
    Text(
        line,
        fontFamily = FontFamily.Monospace,
        style = MaterialTheme.typography.bodySmall,
        color = when {
            line.startsWith("+") && !line.startsWith("+++") -> colors.done
            line.startsWith("-") && !line.startsWith("---") -> colors.failed
            line.startsWith("@@") -> MaterialTheme.colorScheme.primary
            else -> MaterialTheme.colorScheme.onSurface
        },
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .padding(horizontal = 12.dp, vertical = 1.dp),
    )
}

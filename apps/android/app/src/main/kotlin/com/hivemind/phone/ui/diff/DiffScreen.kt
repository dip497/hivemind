package com.hivemind.phone.ui.diff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.DiffFile
import com.hivemind.phone.ui.common.Hairline
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.Mono

/**
 * The files an agent changed: how many, with the lines added and removed in all, then each file
 * with its counts; a file opens to its diff, numbered as the file is (design §6.5).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiffScreen(vm: DiffViewModel, onBack: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { Text(stringResource(R.string.diff_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
                actions = {
                    IconButton(onClick = vm::load) {
                        Icon(Icons.Filled.Refresh, stringResource(R.string.action_refresh), tint = colors.onSurfaceVariant)
                    }
                },
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
        if (state.diff.files.isNotEmpty()) {
            item(key = "summary") { Summary(state.diff.files) }
        }
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
                    val numbered = numbered(lines)
                    items(numbered.size, key = { "${file.path}:$it" }) { PatchLine(numbered[it]) }
                }
            }
        }
    }
}

@Composable
private fun Summary(files: List<DiffFile>) {
    val colors = LocalStateColors.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            pluralStringResource(R.plurals.diff_files, files.size, files.size),
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.weight(1f),
        )
        Text("+${files.sumOf { it.added.toLong() }}", color = colors.done, style = MaterialTheme.typography.labelLarge, fontFamily = Mono)
        Text(
            "−${files.sumOf { it.removed.toLong() }}",
            color = colors.failed,
            style = MaterialTheme.typography.labelLarge,
            fontFamily = Mono,
            modifier = Modifier.padding(start = 8.dp),
        )
    }
    Hairline()
}

@Composable
private fun FileRow(file: DiffFile, onClick: () -> Unit) {
    val colors = LocalStateColors.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(file.status, fontFamily = Mono, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
        Text(
            file.path,
            fontFamily = Mono,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 1,
            overflow = TextOverflow.StartEllipsis,
            modifier = Modifier.weight(1f),
        )
        Text("+${file.added}", color = colors.done, style = MaterialTheme.typography.labelMedium, fontFamily = Mono)
        Text("−${file.removed}", color = colors.failed, style = MaterialTheme.typography.labelMedium, fontFamily = Mono)
    }
}

/** A line of a file's patch, with its number in the file as it is now (as it was, for a line removed). */
private data class Numbered(val line: String, val number: Int?)

/** A file's patch, its header lines left out (its row names the file), each line numbered. */
private fun numbered(lines: List<String>): List<Numbered> {
    val hunk = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)""")
    var old = 0
    var new = 0
    var inHunk = false
    return lines.mapNotNull { line ->
        val start = hunk.find(line)
        when {
            start != null -> {
                old = start.groupValues[1].toInt()
                new = start.groupValues[2].toInt()
                inHunk = true
                Numbered(line, null)
            }
            !inHunk -> null
            line.startsWith("+") -> Numbered(line, new++)
            line.startsWith("-") -> Numbered(line, old++)
            line.startsWith("\\") -> Numbered(line, null)
            else -> Numbered(line, new++).also { old++ }
        }
    }
}

@Composable
private fun PatchLine(numbered: Numbered) {
    val colors = LocalStateColors.current
    val line = numbered.line
    val added = line.startsWith("+")
    val removed = line.startsWith("-")
    val header = line.startsWith("@@")
    Row(
        Modifier
            .fillMaxWidth()
            .background(
                when {
                    added -> colors.done.copy(alpha = 0.10f)
                    removed -> colors.failed.copy(alpha = 0.10f)
                    header -> MaterialTheme.colorScheme.surfaceContainer
                    else -> Color.Transparent
                },
            )
            .padding(vertical = 1.dp),
    ) {
        Text(
            numbered.number?.toString().orEmpty(),
            fontFamily = Mono,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.tertiary,
            textAlign = TextAlign.End,
            modifier = Modifier.width(44.dp).padding(end = 8.dp),
        )
        Text(
            line,
            fontFamily = Mono,
            style = MaterialTheme.typography.bodySmall,
            color = when {
                header -> MaterialTheme.colorScheme.tertiary
                else -> MaterialTheme.colorScheme.onSurface
            },
            maxLines = if (header) 1 else Int.MAX_VALUE,
            overflow = if (header) TextOverflow.Ellipsis else TextOverflow.Clip,
            modifier = Modifier.padding(end = 12.dp),
        )
    }
}

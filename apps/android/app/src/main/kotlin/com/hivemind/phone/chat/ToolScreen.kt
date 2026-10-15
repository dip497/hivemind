package com.hivemind.phone.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.ui.common.GroupLabel
import com.hivemind.phone.ui.common.RaisedCard
import com.hivemind.phone.ui.theme.Mono

/** One use of a tool on a screen of its own: what it was given and what it gave back, whole, red when it failed. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolScreen(call: ToolCall?, onBack: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { Text(call?.name ?: stringResource(R.string.chat_result), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("tool-back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
            )
        },
    ) { padding ->
        SelectionContainer(Modifier.padding(padding)) {
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                call?.about?.let { about ->
                    GroupLabel(stringResource(R.string.tool_input))
                    Block(about, failed = false)
                }
                GroupLabel(stringResource(R.string.tool_output))
                val result = call?.result
                if (result == null) {
                    Text(stringResource(R.string.tool_no_output), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                } else {
                    Block(result.text, failed = result.error)
                }
            }
        }
    }
}

/** Mono text on a raised card, its long lines wrapped, so nothing runs off the screen. */
@Composable
private fun Block(text: String, failed: Boolean) {
    RaisedCard {
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = Mono,
            color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.fillMaxWidth().padding(12.dp),
        )
    }
}

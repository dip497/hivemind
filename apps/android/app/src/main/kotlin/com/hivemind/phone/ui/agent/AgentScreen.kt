package com.hivemind.phone.ui.agent

import androidx.annotation.StringRes
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hivemind.phone.R
import com.hivemind.phone.chat.ChatView
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Waiting
import com.hivemind.phone.live.Ended
import com.hivemind.phone.terminal.TerminalView
import com.hivemind.phone.ui.common.AnswerControls
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.ReplyBox
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.common.stoppable
import com.hivemind.phone.ui.theme.LocalStateColors

/** What the screen shows of the agent: what it says, or its terminal. */
private enum class Shown(@StringRes val label: Int) {
    CHAT(R.string.view_chat),
    TERMINAL(R.string.view_terminal),
}

/** The keys of the Type row, as shown and as `type_keys` takes them. */
private val Keys = listOf(
    "Esc" to "escape", "Tab" to "tab", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right",
    "Enter" to "enter", "Ctrl-C" to "ctrl-c",
)

/**
 * One agent (design §6.4): its live terminal, fitted to the width, or what it and the person say to
 * each other as a chat (P7); what it waits on, as a banner with its answers; a reply box, and Type,
 * which types into its terminal as the person. Stop, Diff and Close at the top; closing asks the
 * phone's lock.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(vm: AgentViewModel, onBack: () -> Unit, onDiff: () -> Unit, onClosed: () -> Unit) {
    val agent by vm.agent.collectAsStateWithLifecycle()
    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(vm.calls, snackbar)
    var shown by rememberSaveable { mutableStateOf(Shown.TERMINAL) }
    var typing by rememberSaveable { mutableStateOf(false) }
    val busy = vm.calls.busy.isNotEmpty()
    val closeTitle = stringResource(R.string.lock_close_title, agent?.name.orEmpty())
    val lockSubtitle = stringResource(R.string.lock_subtitle)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { AgentTitle(agent) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
                actions = {
                    if (agent?.stoppable == true) {
                        TextButton(onClick = vm::stop, enabled = !busy) { Text(stringResource(R.string.action_stop)) }
                    }
                    TextButton(onClick = onDiff) { Text(stringResource(R.string.action_diff)) }
                    TextButton(
                        onClick = {
                            val asked = lock.ask(closeTitle, lockSubtitle) { vm.close(onClosed) }
                            if (!asked) vm.calls.tell(Notice.NoLock)
                        },
                        enabled = !busy && agent != null,
                    ) { Text(stringResource(R.string.action_close)) }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                Shown.entries.forEachIndexed { i, view ->
                    SegmentedButton(
                        selected = shown == view,
                        onClick = { shown = view },
                        shape = SegmentedButtonDefaults.itemShape(i, Shown.entries.size),
                    ) { Text(stringResource(view.label)) }
                }
            }
            // Closed elsewhere, or its device no longer lists it: what its terminal last showed stays.
            if (agent == null) Note(stringResource(R.string.agent_gone))
            agent?.waiting?.let { WaitingBanner(it, busy, vm::answer) }
            when (shown) {
                Shown.CHAT -> ChatView(vm.chat.chat, Modifier.weight(1f).fillMaxWidth())
                Shown.TERMINAL -> {
                    vm.screen.keyboard?.let { holder ->
                        Note(stringResource(R.string.keyboard_held, holder))
                    }
                    vm.screen.ended?.let { ended ->
                        Note(
                            when (ended) {
                                is Ended.Exited -> stringResource(R.string.ended_code, ended.code)
                                Ended.NothingToWatch -> stringResource(R.string.ended_none)
                            },
                        )
                    }
                    TerminalView(vm.screen.terminal, Modifier.weight(1f).fillMaxWidth())
                }
            }
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // Typing is into the terminal: the chat only sends messages.
                val typingShown = typing && shown == Shown.TERMINAL
                if (shown == Shown.TERMINAL) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = !typing, onClick = { typing = false }, label = { Text(stringResource(R.string.mode_message)) })
                        FilterChip(selected = typing, onClick = { typing = true }, label = { Text(stringResource(R.string.mode_type)) })
                    }
                }
                if (typingShown) {
                    TypeBox(vm.typed, enabled = vm.screen.keyboard == null && vm.screen.ended == null, onType = vm::type, onKey = vm::press)
                } else {
                    ReplyBox(stringResource(R.string.message_hint, agent?.name.orEmpty()), busy, onSend = vm::send)
                }
            }
        }
    }
}

@Composable
private fun AgentTitle(agent: Agent?) {
    Column {
        Text(agent?.name.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (agent != null) {
            Text(
                stringResource(R.string.agent_subtitle, agent.state.label(), agent.workspaceName, agent.machine),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun WaitingBanner(waiting: Waiting, busy: Boolean, onAnswer: (Answer) -> Unit) {
    val now = rememberNow()
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                stringResource(R.string.waits_for, waiting.kind.label(), sinceText(waiting.since, now)),
                style = MaterialTheme.typography.labelLarge,
                color = LocalStateColors.current.waiting,
            )
            AnswerControls(waiting, busy, onAnswer)
        }
    }
}

@Composable
private fun Note(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

/** Typed into the terminal as it changes, as the person, with a row of the keys a phone lacks. */
@Composable
private fun TypeBox(typed: String, enabled: Boolean, onType: (String) -> Unit, onKey: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((label, key) in Keys) {
                OutlinedButton(onClick = { onKey(key) }, enabled = enabled) { Text(label) }
            }
        }
        OutlinedTextField(
            value = typed,
            onValueChange = onType,
            enabled = enabled,
            singleLine = true,
            placeholder = { Text(stringResource(R.string.type_hint)) },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Ascii,
                imeAction = ImeAction.Send,
            ),
            keyboardActions = KeyboardActions(onSend = { onKey("enter") }),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

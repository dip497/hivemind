package com.hivemind.phone.ui.agent

import androidx.annotation.StringRes
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
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
import com.hivemind.phone.core.ScreenEnded
import com.hivemind.phone.core.Waiting
import com.hivemind.phone.terminal.TerminalView
import com.hivemind.phone.ui.common.AnswerControls
import com.hivemind.phone.ui.common.Dot
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.PillChip
import com.hivemind.phone.ui.common.RaisedCard
import com.hivemind.phone.ui.common.asked
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.common.stoppable
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.Mono

/** What the screen shows of the agent: what it says, or its terminal. */
internal enum class Shown(@StringRes val label: Int) {
    CHAT(R.string.view_chat),
    TERMINAL(R.string.view_terminal),
}

/** What may be shown of [agent], as offered: what it and the person say only when it keeps a
 *  conversation its device can read (its manifest maps its session file), and its terminal. */
internal fun shownOf(agent: Agent?): List<Shown> = if (agent?.hasConversation == true) Shown.entries else listOf(Shown.TERMINAL)

/** The keys of the Type row, as shown and as `type_keys` takes them. */
private val Keys = listOf(
    "Esc" to "escape", "Tab" to "tab", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right",
    "Enter" to "enter", "Ctrl-C" to "ctrl-c",
)

/**
 * One agent (design §6.4): its live terminal, fitted to the width, or what it and the person say to
 * each other as a chat (P7); what it waits on, as a card with its answers; a composer whose send
 * stops the agent's turn while nothing is typed, and Type, which types into its terminal as the
 * person. Diff at the top, Close under More; closing asks the phone's lock.
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

    val offered = shownOf(agent)
    // As the person chose, when this agent offers it.
    val showing = shown.takeIf { it in offered } ?: Shown.TERMINAL
    // Typing is into the terminal: the chat only sends messages.
    val typingShown = typing && showing == Shown.TERMINAL
    val colors = MaterialTheme.colorScheme

    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { AgentTitle(agent) },
                navigationIcon = {
                    // Tagged for the UI tests: the system's own Back is "Back" too.
                    IconButton(onClick = onBack, modifier = Modifier.testTag("agent-back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
                actions = {
                    // Stop is the composer's while it sends messages; the Type box has no room for it.
                    if (typingShown && agent?.stoppable == true) {
                        TextButton(onClick = vm::stop, enabled = !busy) { Text(stringResource(R.string.action_stop)) }
                    }
                    TextButton(onClick = onDiff, colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurfaceVariant)) {
                        Text(stringResource(R.string.action_diff))
                    }
                    var menu by remember { mutableStateOf(false) }
                    IconButton(onClick = { menu = true }) {
                        Icon(Icons.Filled.MoreVert, stringResource(R.string.action_more), tint = colors.onSurfaceVariant)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.action_close)) },
                            enabled = !busy && agent != null,
                            onClick = {
                                menu = false
                                val asked = lock.ask(closeTitle, lockSubtitle) { vm.close(onClosed) }
                                if (!asked) vm.calls.tell(Notice.NoLock)
                            },
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            if (offered.size > 1) {
                Segmented(offered, showing, onChoose = { shown = it }, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            // Closed elsewhere, or its device no longer lists it: what its terminal last showed stays.
            if (agent == null) Note(stringResource(R.string.agent_gone))
            agent?.waiting?.let { WaitingCard(it, busy, vm::answer) }
            when (showing) {
                Shown.CHAT -> ChatView(vm.chat.chat, Modifier.weight(1f).fillMaxWidth())
                Shown.TERMINAL -> {
                    vm.screen.keyboard?.let { holder ->
                        Note(stringResource(R.string.keyboard_held, holder))
                    }
                    vm.screen.ended?.let { ended -> Note(endedNote(ended, agent?.deviceName)) }
                    TerminalView(vm.screen.terminal, Modifier.weight(1f).fillMaxWidth())
                }
            }
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (showing == Shown.TERMINAL) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PillChip(!typing, onClick = { typing = false }, label = stringResource(R.string.mode_message))
                        PillChip(typing, onClick = { typing = true }, label = stringResource(R.string.mode_type))
                    }
                }
                if (typingShown) {
                    TypeBox(vm.typed, enabled = vm.screen.keyboard == null && vm.screen.ended == null, onType = vm::type, onKey = vm::press)
                } else {
                    Composer(
                        stringResource(R.string.message_hint, agent?.name.orEmpty()),
                        busy,
                        stoppable = agent?.stoppable == true,
                        onSend = vm::send,
                        onStop = vm::stop,
                    )
                }
            }
        }
    }
}

/** Chat or Terminal: what is shown of the agent, as a pill with the shown one filled. */
@Composable
private fun Segmented(offered: List<Shown>, showing: Shown, onChoose: (Shown) -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Surface(color = colors.surfaceContainerHigh, shape = CircleShape, modifier = modifier) {
        Row(Modifier.padding(3.dp)) {
            for (view in offered) {
                val chosen = view == showing
                Surface(
                    selected = chosen,
                    onClick = { onChoose(view) },
                    shape = CircleShape,
                    color = if (chosen) colors.background else Color.Transparent,
                    shadowElevation = if (chosen) 1.dp else 0.dp,
                ) {
                    Text(
                        stringResource(view.label),
                        style = MaterialTheme.typography.labelLarge,
                        color = if (chosen) colors.onSurface else colors.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                }
            }
        }
    }
}

/**
 * What the person says to the agent: a raised card pinned under the conversation, with a round
 * send; while the agent is in a turn it can be stopped from, and nothing is typed, the button stops it.
 */
@Composable
private fun Composer(hint: String, busy: Boolean, stoppable: Boolean, onSend: (String) -> Unit, onStop: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val send = {
        if (text.isNotBlank()) {
            onSend(text)
            text = ""
        }
    }
    val colors = MaterialTheme.colorScheme
    RaisedCard(Modifier.shadow(4.dp, MaterialTheme.shapes.large, ambientColor = Color.Black.copy(alpha = 0.06f), spotColor = Color.Black.copy(alpha = 0.06f))) {
        Row(Modifier.padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                singleLine = true,
                enabled = !busy,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                    focusedPlaceholderColor = colors.tertiary,
                    unfocusedPlaceholderColor = colors.tertiary,
                ),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { send() }),
                modifier = Modifier.weight(1f).testTag("reply"),
            )
            if (stoppable && text.isEmpty()) {
                FilledIconButton(onClick = onStop, enabled = !busy, modifier = Modifier.size(36.dp)) {
                    Icon(painterResource(R.drawable.ic_stop), stringResource(R.string.action_stop), modifier = Modifier.size(16.dp))
                }
            } else {
                FilledIconButton(onClick = send, enabled = !busy && text.isNotBlank(), modifier = Modifier.size(36.dp).testTag("reply-send")) {
                    Icon(painterResource(R.drawable.ic_send_up), stringResource(R.string.action_send), modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

/** How its terminal's watch ended, in words: [device] is the agent's device, by name, while it is listed. */
@Composable
private fun endedNote(ended: ScreenEnded, device: String?): String {
    val where = device ?: stringResource(R.string.its_device)
    return when (ended) {
        is ScreenEnded.Exited -> stringResource(R.string.ended_code, ended.code)
        ScreenEnded.NoSession -> stringResource(R.string.ended_none)
        is ScreenEnded.Refused -> stringResource(R.string.ended_refused, where, ended.why)
        ScreenEnded.NotHeld -> stringResource(R.string.ended_not_held, where)
        ScreenEnded.Unpaired -> stringResource(R.string.ended_unpaired, where)
    }
}

@Composable
private fun AgentTitle(agent: Agent?) {
    Column {
        Text(agent?.name.orEmpty(), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (agent != null) {
            Text(
                stringResource(R.string.agent_subtitle, agent.state.label(), agent.workspaceName, agent.machine),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.tertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** What the agent waits on, as a card over the conversation, with its answers. */
@Composable
private fun WaitingCard(waiting: Waiting, busy: Boolean, onAnswer: (Answer) -> Unit) {
    val now = rememberNow()
    RaisedCard(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Dot(LocalStateColors.current.waiting)
                Text(
                    stringResource(R.string.waits_for, waiting.kind.asked(), sinceText(waiting.since, now)),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
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
                OutlinedButton(
                    onClick = { onKey(key) },
                    enabled = enabled,
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                ) { Text(label, fontFamily = Mono) }
            }
        }
        OutlinedTextField(
            value = typed,
            onValueChange = onType,
            enabled = enabled,
            singleLine = true,
            shape = MaterialTheme.shapes.large,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = Mono),
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

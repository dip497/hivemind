package com.hivemind.phone.ui.agent

import androidx.activity.compose.BackHandler
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hivemind.phone.R
import com.hivemind.phone.chat.ChatView
import com.hivemind.phone.chat.ToolScreen
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.ScreenEnded
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.core.Waiting
import com.hivemind.phone.terminal.TermSize
import com.hivemind.phone.terminal.TerminalView
import com.hivemind.phone.ui.common.AnswerControls
import com.hivemind.phone.ui.common.Dot
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.PillChip
import com.hivemind.phone.ui.common.RaisedCard
import com.hivemind.phone.ui.common.asked
import com.hivemind.phone.ui.common.composerAnswers
import com.hivemind.phone.ui.common.StateMark
import com.hivemind.phone.ui.common.elapsed
import com.hivemind.phone.ui.common.label
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.common.stoppable
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.Mono
import kotlinx.coroutines.delay

/** Whether [agent]'s screen opens on what it and the person say: only when it keeps a conversation
 *  its device can read (its manifest maps its session file). Any other opens on its terminal. */
internal fun opensOnChat(agent: Agent?): Boolean = agent?.hasConversation == true

/** How long the terminal's size stays put before the session is fitted to it. */
private const val FIT_SETTLES_MS = 200L

/** The keys of the Type row, as shown and as `type_keys` takes them. */
private val Keys = listOf(
    "Esc" to "escape", "Tab" to "tab", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right",
    "Enter" to "enter", "Ctrl-C" to "ctrl-c",
)

/**
 * One agent (design §6.4): what it and the person say to each other as a chat (P7), what it waits
 * on as the chat's last card, and a composer whose send stops the agent's turn while nothing is
 * typed. Its terminal opens from the header over the whole screen, sized to the phone until Fit is
 * let go, with Type, which types into it as the person; an agent with no
 * chat to read opens on it. A tool's row opens that use on its own screen. Diff at the top, Close
 * under More; closing asks the phone's lock.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(vm: AgentViewModel, onBack: () -> Unit, onDiff: () -> Unit, onClosed: () -> Unit) {
    val agent by vm.agent.collectAsStateWithLifecycle()
    val chatFirst = opensOnChat(agent)
    var terminalOpen by rememberSaveable { mutableStateOf(false) }
    var toolOpen by rememberSaveable { mutableStateOf<String?>(null) }
    val tool = toolOpen?.takeIf { chatFirst }
    if (tool != null) {
        BackHandler { toolOpen = null }
        ToolScreen(vm.chat.chat.toolCall(tool), onBack = { toolOpen = null })
        return
    }
    // Over the chat: back returns to it.
    val overChat = terminalOpen && chatFirst
    BackHandler(enabled = overChat) { terminalOpen = false }
    val showingTerminal = overChat || !chatFirst
    SideEffect { vm.screen.shown(showingTerminal) }

    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(vm.calls, snackbar)
    var typing by rememberSaveable { mutableStateOf(false) }
    var fit by rememberSaveable { mutableStateOf(true) }
    val busy = vm.calls.busy.isNotEmpty()
    val closeTitle = stringResource(R.string.lock_close_title, agent?.name.orEmpty())
    val lockSubtitle = stringResource(R.string.lock_subtitle)
    // Typing is into the terminal: the chat only sends messages.
    val typingShown = typing && showingTerminal
    val colors = MaterialTheme.colorScheme

    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { AgentTitle(agent) },
                navigationIcon = {
                    // Tagged for the UI tests: the system's own Back is "Back" too.
                    IconButton(
                        onClick = if (overChat) ({ terminalOpen = false }) else onBack,
                        modifier = Modifier.testTag(if (overChat) "terminal-back" else "agent-back"),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
                actions = {
                    // Stop is the composer's while it sends messages; the Type box has no room for it.
                    if (typingShown && agent?.stoppable == true) {
                        TextButton(onClick = vm::stop, enabled = !busy) { Text(stringResource(R.string.action_stop)) }
                    }
                    if (showingTerminal) {
                        PillChip(
                            fit && !vm.screen.takenBack,
                            onClick = { if (fit && vm.screen.takenBack) vm.screen.fitAgain() else fit = !fit },
                            label = stringResource(R.string.terminal_fit), modifier = Modifier.testTag("terminal-fit"))
                    }
                    if (!overChat) {
                        if (chatFirst) {
                            IconButton(onClick = { terminalOpen = true }, modifier = Modifier.testTag("agent-terminal")) {
                                Icon(painterResource(R.drawable.ic_terminal), stringResource(R.string.view_terminal), tint = colors.onSurfaceVariant)
                            }
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
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
            // Closed elsewhere, or its device no longer lists it: what its terminal last showed stays.
            if (agent == null) Note(stringResource(R.string.agent_gone))
            if (showingTerminal) {
                agent?.waiting?.let { WaitingCard(it, busy, vm::answer, Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) }
                vm.screen.keyboard?.let { holder ->
                    Note(stringResource(R.string.keyboard_held, holder))
                }
                vm.screen.ended?.let { ended -> Note(endedNote(ended, agent?.deviceName)) }
                // Fitted to the phone while Fit is on and the app is in sight; the size it had, given back once
                // Fit is off, the terminal is left or the app goes to the background.
                var readable by remember { mutableStateOf<TermSize?>(null) }
                var fitted by remember { mutableStateOf(false) }
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(fit, readable) {
                    val size = readable
                    // Fitted at once when opened, then to the size it settles at: while the keyboard
                    // slides, each frame is another size, and each fit is a resize the agent redraws
                    // its whole screen for.
                    if (!fit) vm.screen.unfit() else if (size != null) {
                        if (fitted) delay(FIT_SETTLES_MS)
                        // Gone to the background meanwhile: its size was given back, and stays so.
                        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                            vm.screen.fit(size)
                            fitted = true
                        }
                    }
                }
                val fitNow by rememberUpdatedState(fit)
                val readableNow by rememberUpdatedState(readable)
                LifecycleStartEffect(vm.screen) {
                    if (fitNow) readableNow?.let(vm.screen::fit)
                    onStopOrDispose { vm.screen.unfit() }
                }
                TerminalView(vm.screen.terminal, Modifier.weight(1f).fillMaxWidth(), onReadableSize = { readable = it }, onScroll = vm.screen::scroll)
            } else {
                val waiting = agent?.waiting
                ChatView(
                    vm.chat.chat,
                    onTool = { toolOpen = it },
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    endKey = waiting?.since,
                    end = { if (waiting != null) WaitingCard(waiting, busy, vm::answer, ownReply = !composerAnswers(waiting)) },
                )
            }
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (showingTerminal) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PillChip(!typing, onClick = { typing = false }, label = stringResource(R.string.mode_message))
                        PillChip(typing, onClick = { typing = true }, label = stringResource(R.string.mode_type))
                    }
                }
                if (!showingTerminal) agent?.let { WorkingLine(it) }
                if (typingShown) {
                    TypeBox(vm.typed, enabled = vm.screen.keyboard == null && vm.screen.ended == null, onType = vm::type, onKey = vm::press)
                } else {
                    // In the chat, what the agent waits on in words is answered from here: one place to type.
                    val waiting = agent?.waiting?.takeIf { !showingTerminal && composerAnswers(it) }
                    Composer(
                        when {
                            waiting == null -> stringResource(R.string.message_hint, agent?.name.orEmpty())
                            waiting.kind == WaitKind.QUESTION -> stringResource(R.string.own_answer_or_hint)
                            else -> stringResource(R.string.reply_hint)
                        },
                        busy,
                        stoppable = agent?.stoppable == true && waiting == null,
                        target = waiting?.since?.let { "wait:$it" } ?: "message",
                        onSend = { if (waiting == null) vm.send(it) else vm.answer(Answer.Text(it)) },
                        onStop = vm::stop,
                        onRetarget = { vm.calls.tell(Notice.Retargeted) },
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
private fun Composer(
    hint: String,
    busy: Boolean,
    stoppable: Boolean,
    target: String,
    onSend: (String) -> Unit,
    onStop: () -> Unit,
    onRetarget: () -> Unit,
) {
    var text by rememberSaveable { mutableStateOf("") }
    // What the text was begun for: a message, or the answer to one wait. Sent only to that; if what the
    // agent waits on changed meanwhile, the first Send says so and the next sends it to what is there now.
    var typedFor by rememberSaveable { mutableStateOf(target) }
    val send = {
        if (text.isNotBlank()) {
            if (typedFor != target) {
                typedFor = target
                onRetarget()
            } else {
                onSend(text)
                text = ""
            }
        }
    }
    val colors = MaterialTheme.colorScheme
    RaisedCard(Modifier.shadow(4.dp, MaterialTheme.shapes.large, ambientColor = Color.Black.copy(alpha = 0.06f), spotColor = Color.Black.copy(alpha = 0.06f))) {
        Row(Modifier.padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.Bottom) {
            TextField(
                value = text,
                onValueChange = {
                    if (text.isEmpty()) typedFor = target
                    text = it
                },
                placeholder = { Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                // Grows with what is typed, up to six lines; Enter is a new line, the button sends.
                maxLines = 6,
                textStyle = MaterialTheme.typography.bodyLarge,
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
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.weight(1f).testTag("reply"),
            )
            if (stoppable && text.isEmpty()) {
                FilledIconButton(onClick = onStop, enabled = !busy, modifier = Modifier.padding(bottom = 10.dp).size(36.dp)) {
                    Icon(painterResource(R.drawable.ic_stop), stringResource(R.string.action_stop), modifier = Modifier.size(16.dp))
                }
            } else {
                FilledIconButton(onClick = send, enabled = !busy && text.isNotBlank(), modifier = Modifier.padding(bottom = 10.dp).size(36.dp).testTag("reply-send")) {
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

/** While the agent works, how long for, under the chat: a dot and "working · 12s", counted each second (design PB §12.12). */
@Composable
private fun WorkingLine(agent: Agent) {
    val since = agent.since
    if (agent.state != AgentState.WORKING || since == null) return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Dot(LocalStateColors.current.working)
        Text(
            stringResource(R.string.working_for, elapsed(now - since.toLong())),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 8.dp).testTag("working-line"),
        )
    }
}

/** The agent's name, a spinner beside it while it works, and where it runs under it. */
@Composable
private fun AgentTitle(agent: Agent?) {
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(agent?.name.orEmpty(), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            StateMark(agent?.state, Modifier.padding(start = 8.dp))
        }
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

/** What the agent waits on, as a card with its answers: the chat's last, or over its terminal. */
@Composable
private fun WaitingCard(waiting: Waiting, busy: Boolean, onAnswer: (Answer) -> Unit, modifier: Modifier = Modifier, ownReply: Boolean = true) {
    val now = rememberNow()
    RaisedCard(modifier) {
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
            AnswerControls(waiting, busy, onAnswer, ownReply = ownReply)
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

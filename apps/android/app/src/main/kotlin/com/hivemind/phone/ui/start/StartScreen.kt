package com.hivemind.phone.ui.start

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.StartOption
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect

/**
 * Device, then workspace, then folder, then agent (with its model and mode, when it has them), then
 * a prompt; Start asks the phone's lock, and opens the new agent's screen (design §6.6).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun StartScreen(vm: StartViewModel, onBack: () -> Unit, onStarted: (AgentRef) -> Unit) {
    val places by vm.places.collectAsStateWithLifecycle()
    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(vm.calls, snackbar)
    val lockTitle = stringResource(R.string.lock_start_title, vm.program?.label.orEmpty())
    val lockSubtitle = stringResource(R.string.lock_subtitle)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.start_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (places.isEmpty()) {
                Text(stringResource(R.string.start_no_places), color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            Heading(stringResource(R.string.start_device))
            val device = vm.device
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (place in places.distinctBy { it.device }) {
                    FilterChip(
                        selected = place.device == device,
                        onClick = { vm.chooseDevice(place.device) },
                        label = { Text(place.deviceName) },
                    )
                }
            }
            if (device == null) return@Column

            Heading(stringResource(R.string.start_workspace))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (place in places.filter { it.device == device }) {
                    FilterChip(selected = place == vm.place, onClick = { vm.choose(place) }, label = { Text(place.workspaceName) })
                }
            }

            when (val choices = vm.choices) {
                null -> Unit
                Choices.Loading -> CircularProgressIndicator()
                is Choices.Failed -> Text(choices.message, color = MaterialTheme.colorScheme.error)
                is Choices.Ready -> {
                    val startable = choices.startable
                    if (startable.frames.isNotEmpty()) {
                        Heading(stringResource(R.string.start_folder))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (frame in startable.frames) {
                                FilterChip(
                                    selected = vm.frame == frame.id,
                                    onClick = { vm.frame = frame.id },
                                    label = { Text(stringResource(R.string.where, frame.name, frame.machine)) },
                                )
                            }
                        }
                    }
                    Heading(stringResource(R.string.start_agent))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (program in startable.programs) {
                            FilterChip(selected = vm.program?.id == program.id, onClick = { vm.choose(program) }, label = { Text(program.label) })
                        }
                    }
                    vm.program?.options?.forEach { option -> OptionChoice(option, vm.options[option.id]) { vm.options[option.id] = it } }
                    OutlinedTextField(
                        value = vm.prompt,
                        onValueChange = { vm.prompt = it },
                        label = { Text(stringResource(R.string.start_prompt)) },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = {
                            val asked = lock.ask(lockTitle, lockSubtitle) { vm.start(onStarted) }
                            if (!asked) vm.calls.tell(Notice.NoLock)
                        },
                        enabled = vm.program != null && vm.calls.busy.isEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.action_start)) }
                }
            }
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
}

/** One of a program's options: its values to pick from, or free text when it lists none. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionChoice(option: StartOption, chosen: String?, onChoose: (String) -> Unit) {
    Heading(option.label)
    if (option.values.isEmpty()) {
        OutlinedTextField(
            value = chosen.orEmpty(),
            onValueChange = onChoose,
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    } else {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (value in option.values) {
                FilterChip(selected = chosen == value, onClick = { onChoose(value) }, label = { Text(value) })
            }
        }
    }
}

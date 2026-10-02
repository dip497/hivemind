package com.hivemind.phone.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.hivemind.phone.PhoneCore
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.ui.agents.AgentsList
import com.hivemind.phone.ui.agents.AgentsViewModel
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.devices.DevicesList
import com.hivemind.phone.ui.devices.DevicesViewModel
import com.hivemind.phone.ui.needs.NeedsList
import com.hivemind.phone.ui.needs.NeedsViewModel

private enum class Tab { NEEDS, AGENTS, DEVICES }

/** The three tabs: Needs you (home), Agents, Devices (design §6.2, §6.3, §6.7). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(core: PhoneCore, onOpen: (AgentRef) -> Unit, onStart: () -> Unit, onPair: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf(Tab.NEEDS) }
    val needs = viewModel { NeedsViewModel(core.phone, core.feed.overview) }
    val agents = viewModel { AgentsViewModel(core.phone, core.feed.overview) }
    val devices = viewModel { DevicesViewModel(core.phone, core.feed.overview) }
    val needsState by needs.state.collectAsStateWithLifecycle()
    val now = rememberNow()
    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(needs.calls, snackbar)
    NoticeEffect(agents.calls, snackbar)
    NoticeEffect(devices.calls, snackbar)
    val resources = LocalResources.current

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(
                            when (tab) {
                                Tab.NEEDS -> R.string.tab_needs
                                Tab.AGENTS -> R.string.tab_agents
                                Tab.DEVICES -> R.string.tab_devices
                            },
                        ),
                    )
                },
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == Tab.NEEDS,
                    onClick = { tab = Tab.NEEDS },
                    icon = {
                        BadgedBox(badge = { if (needsState.needs.isNotEmpty()) Badge { Text("${needsState.needs.size}") } }) {
                            Icon(Icons.Filled.Notifications, null)
                        }
                    },
                    label = { Text(stringResource(R.string.tab_needs)) },
                )
                NavigationBarItem(
                    selected = tab == Tab.AGENTS,
                    onClick = { tab = Tab.AGENTS },
                    icon = { Icon(Icons.AutoMirrored.Filled.List, null) },
                    label = { Text(stringResource(R.string.tab_agents)) },
                )
                NavigationBarItem(
                    selected = tab == Tab.DEVICES,
                    onClick = { tab = Tab.DEVICES },
                    icon = { Icon(Icons.Filled.AccountCircle, null) },
                    label = { Text(stringResource(R.string.tab_devices)) },
                )
            }
        },
        floatingActionButton = {
            if (tab == Tab.AGENTS) {
                FloatingActionButton(onClick = onStart) { Icon(Icons.Filled.Add, stringResource(R.string.start_title)) }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val inside = Modifier.padding(padding)
        when (tab) {
            Tab.NEEDS -> NeedsList(needsState, needs.calls.busy, now, onOpen, needs::answer, inside)
            Tab.AGENTS -> {
                val state by agents.state.collectAsStateWithLifecycle()
                AgentsList(
                    state,
                    agents.calls.busy,
                    now,
                    onOpen = onOpen,
                    onStop = agents::stop,
                    onClose = { agent ->
                        val asked = lock.ask(
                            resources.getString(R.string.lock_close_title, agent.name),
                            resources.getString(R.string.lock_subtitle),
                        ) { agents.close(agent) }
                        if (!asked) agents.calls.tell(Notice.NoLock)
                    },
                    modifier = inside,
                )
            }
            Tab.DEVICES -> {
                val state by devices.state.collectAsStateWithLifecycle()
                val push by core.push.state.collectAsStateWithLifecycle()
                val activity = LocalActivity.current
                DevicesList(
                    state,
                    devices.calls.busy,
                    now,
                    onUnpair = devices::unpair,
                    onPair = onPair,
                    push = push,
                    onChoosePush = { activity?.let(core.push::choose) },
                    onPushAgain = core.push::again,
                    modifier = inside,
                )
            }
        }
    }
}

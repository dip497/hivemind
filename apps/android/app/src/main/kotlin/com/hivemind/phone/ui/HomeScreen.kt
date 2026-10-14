package com.hivemind.phone.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Home
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.hivemind.phone.PhoneCore
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.devices.DevicesList
import com.hivemind.phone.ui.devices.DevicesViewModel
import com.hivemind.phone.ui.home.HomeList
import com.hivemind.phone.ui.home.HomeViewModel
import com.hivemind.phone.ui.views.ViewRow
import com.hivemind.phone.ui.views.ViewsList
import com.hivemind.phone.ui.views.ViewsViewModel

private enum class Tab { HOME, VIEWS, DEVICES }

/** The three tabs: Home, the desktop's Layers panel with what needs the person on top (B5 §11.2), Views, Devices (design §6.9, §6.7). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    core: PhoneCore,
    onOpen: (AgentRef) -> Unit,
    onStart: () -> Unit,
    onPair: () -> Unit,
    onOpenView: (ViewRow) -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    val home = viewModel { HomeViewModel(core.phone, core.feed.overview) }
    val devices = viewModel { DevicesViewModel(core.phone, core.feed.overview) }
    val views = viewModel { ViewsViewModel(core.phone, core.feed.overview) }
    val homeState by home.state.collectAsStateWithLifecycle()
    val now = rememberNow()
    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(home.calls, snackbar)
    NoticeEffect(devices.calls, snackbar)
    val resources = LocalResources.current
    LaunchedEffect(tab) { if (tab == Tab.VIEWS) views.again() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(
                            when (tab) {
                                Tab.HOME -> R.string.tab_home
                                Tab.VIEWS -> R.string.tab_views
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
                    selected = tab == Tab.HOME,
                    onClick = { tab = Tab.HOME },
                    icon = {
                        BadgedBox(badge = { if (homeState.needs.needs.isNotEmpty()) Badge { Text("${homeState.needs.needs.size}") } }) {
                            Icon(Icons.Filled.Home, null)
                        }
                    },
                    label = { Text(stringResource(R.string.tab_home)) },
                )
                NavigationBarItem(
                    selected = tab == Tab.VIEWS,
                    onClick = { tab = Tab.VIEWS },
                    icon = { Icon(painterResource(R.drawable.ic_views), null) },
                    label = { Text(stringResource(R.string.tab_views)) },
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
            if (tab == Tab.HOME) {
                FloatingActionButton(onClick = onStart) { Icon(Icons.Filled.Add, stringResource(R.string.start_title)) }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val inside = Modifier.padding(padding)
        when (tab) {
            Tab.HOME -> HomeList(
                homeState,
                home.calls.busy,
                now,
                onSearch = home::search,
                onMachine = home::choose,
                onOpen = onOpen,
                onAnswer = home::answer,
                onStop = home::stop,
                onClose = { agent ->
                    val asked = lock.ask(
                        resources.getString(R.string.lock_close_title, agent.name),
                        resources.getString(R.string.lock_subtitle),
                    ) { home.close(agent) }
                    if (!asked) home.calls.tell(Notice.NoLock)
                },
                onStart = onStart,
                modifier = inside,
            )
            Tab.VIEWS -> {
                val rows by views.rows.collectAsStateWithLifecycle()
                ViewsList(rows, views.refreshing, onRefresh = views::refresh, onOpen = onOpenView, modifier = inside)
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

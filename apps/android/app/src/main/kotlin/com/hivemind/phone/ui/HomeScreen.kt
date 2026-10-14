package com.hivemind.phone.ui

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.hivemind.phone.PhoneCore
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.ui.common.Hairline
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.devices.DevicesList
import com.hivemind.phone.ui.devices.DevicesViewModel
import com.hivemind.phone.ui.home.HomeList
import com.hivemind.phone.ui.home.HomeViewModel
import com.hivemind.phone.ui.theme.LocalStateColors
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
    var searching by rememberSaveable { mutableStateOf(false) }
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

    val colors = MaterialTheme.colorScheme
    val quiet = NavigationBarItemDefaults.colors(
        selectedIconColor = colors.onSurface,
        selectedTextColor = colors.onSurface,
        unselectedIconColor = colors.tertiary,
        unselectedTextColor = colors.tertiary,
        indicatorColor = Color.Transparent,
    )
    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                actions = {
                    if (tab == Tab.HOME) {
                        IconButton(onClick = { searching = !searching }) {
                            Icon(Icons.Filled.Search, stringResource(R.string.home_search), tint = colors.onSurfaceVariant)
                        }
                    }
                },
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
            Column {
                Hairline()
                NavigationBar(containerColor = colors.background, tonalElevation = 0.dp) {
                    NavigationBarItem(
                        selected = tab == Tab.HOME,
                        onClick = { tab = Tab.HOME },
                        icon = {
                            BadgedBox(
                                badge = {
                                    if (homeState.needs.needs.isNotEmpty()) {
                                        Badge(containerColor = LocalStateColors.current.waiting, contentColor = colors.background) {
                                            Text("${homeState.needs.needs.size}")
                                        }
                                    }
                                },
                            ) {
                                Icon(Icons.Filled.Home, null)
                            }
                        },
                        label = { Text(stringResource(R.string.tab_home)) },
                        colors = quiet,
                    )
                    NavigationBarItem(
                        selected = tab == Tab.VIEWS,
                        onClick = { tab = Tab.VIEWS },
                        icon = { Icon(painterResource(R.drawable.ic_views), null) },
                        label = { Text(stringResource(R.string.tab_views)) },
                        colors = quiet,
                    )
                    NavigationBarItem(
                        selected = tab == Tab.DEVICES,
                        onClick = { tab = Tab.DEVICES },
                        icon = { Icon(Icons.Filled.AccountCircle, null) },
                        label = { Text(stringResource(R.string.tab_devices)) },
                        colors = quiet,
                    )
                }
            }
        },
        floatingActionButton = {
            if (tab == Tab.HOME) {
                FloatingActionButton(
                    onClick = onStart,
                    shape = CircleShape,
                    containerColor = colors.primary,
                    contentColor = colors.onPrimary,
                    elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 2.dp, pressedElevation = 4.dp),
                ) { Icon(Icons.Filled.Add, stringResource(R.string.start_title)) }
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
                searching = searching,
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

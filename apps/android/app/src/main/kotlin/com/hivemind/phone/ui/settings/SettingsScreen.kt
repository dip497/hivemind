package com.hivemind.phone.ui.settings

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.hivemind.phone.PhoneCore
import com.hivemind.phone.R
import com.hivemind.phone.ui.common.GroupLabel
import com.hivemind.phone.ui.common.Hairline
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.devices.DevicesViewModel
import com.hivemind.phone.ui.devices.UnpairDialog
import com.hivemind.phone.ui.devices.devicesItems
import com.hivemind.phone.ui.views.ViewRow
import com.hivemind.phone.ui.views.ViewsViewModel
import com.hivemind.phone.ui.views.viewsItems

/**
 * Settings, opened from Home's gear: the person's devices, pairing another and how they tell the
 * phone while the app is away (design §6.7, P6); then the community views they offer it (screen 9),
 * asked for again on opening and when pulled down.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(core: PhoneCore, onBack: () -> Unit, onPair: () -> Unit, onOpenView: (ViewRow) -> Unit) {
    val devices = viewModel { DevicesViewModel(core.phone, core.feed.overview) }
    val views = viewModel { ViewsViewModel(core.phone, core.feed.overview) }
    val state by devices.state.collectAsStateWithLifecycle()
    val push by core.push.state.collectAsStateWithLifecycle()
    val rows by views.rows.collectAsStateWithLifecycle()
    val activity = LocalActivity.current
    val now = rememberNow()
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(devices.calls, snackbar)
    LaunchedEffect(views) { views.again() }
    var unpairing by rememberSaveable { mutableStateOf<String?>(null) }
    val colors = MaterialTheme.colorScheme

    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("settings-back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = views.refreshing, onRefresh = views::refresh, modifier = Modifier.padding(padding).fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item(key = "devices-label") { GroupLabel(stringResource(R.string.settings_devices), Modifier.padding(start = 16.dp, top = 8.dp)) }
                devicesItems(
                    state,
                    devices.calls.busy,
                    now,
                    onUnpair = { unpairing = it.id },
                    onPair = onPair,
                    push = push,
                    onChoosePush = { activity?.let(core.push::choose) },
                    onPushAgain = core.push::again,
                )
                item(key = "views-label") {
                    Hairline(Modifier.padding(vertical = 8.dp))
                    GroupLabel(stringResource(R.string.settings_views), Modifier.padding(start = 16.dp, top = 8.dp))
                }
                viewsItems(rows, onOpen = onOpenView)
            }
        }
    }
    state.devices.firstOrNull { it.id == unpairing }?.let { device ->
        UnpairDialog(device, onUnpair = { devices.unpair(device) }, onDismiss = { unpairing = null })
    }
}

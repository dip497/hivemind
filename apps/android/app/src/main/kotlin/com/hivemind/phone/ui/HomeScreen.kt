package com.hivemind.phone.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.hivemind.phone.PhoneCore
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.rememberNow
import com.hivemind.phone.ui.home.HomeList
import com.hivemind.phone.ui.home.HomeViewModel

/**
 * Home, the app: the desktop's Layers panel, with what needs the person on top (B5 §11.2); search
 * and Settings in its header, and + to start an agent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    core: PhoneCore,
    onOpen: (AgentRef) -> Unit,
    onStart: () -> Unit,
    onSettings: () -> Unit,
) {
    var searching by rememberSaveable { mutableStateOf(false) }
    val home = viewModel { HomeViewModel(core.phone, core.feed.overview) }
    val homeState by home.state.collectAsStateWithLifecycle()
    val now = rememberNow()
    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(home.calls, snackbar)
    val resources = LocalResources.current

    val colors = MaterialTheme.colorScheme
    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { Text(stringResource(R.string.home_title)) },
                actions = {
                    IconButton(onClick = { searching = !searching }) {
                        Icon(Icons.Filled.Search, stringResource(R.string.home_search), tint = colors.onSurfaceVariant)
                    }
                    IconButton(onClick = onSettings, modifier = Modifier.testTag("home-settings")) {
                        Icon(Icons.Filled.Settings, stringResource(R.string.settings_title), tint = colors.onSurfaceVariant)
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = onStart,
                shape = CircleShape,
                containerColor = colors.primary,
                contentColor = colors.onPrimary,
                elevation = FloatingActionButtonDefaults.elevation(defaultElevation = 2.dp, pressedElevation = 4.dp),
            ) { Icon(Icons.Filled.Add, stringResource(R.string.start_title)) }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        HomeList(
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
            modifier = Modifier.padding(padding),
            searching = searching,
        )
    }
}

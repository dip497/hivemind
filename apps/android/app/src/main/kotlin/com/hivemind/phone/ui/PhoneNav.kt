package com.hivemind.phone.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import com.hivemind.phone.PhoneCore
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.ui.agent.AgentScreen
import com.hivemind.phone.ui.agent.AgentViewModel
import com.hivemind.phone.ui.diff.DiffScreen
import com.hivemind.phone.ui.diff.DiffViewModel
import com.hivemind.phone.ui.pair.PairScreen
import com.hivemind.phone.ui.pair.PairViewModel
import com.hivemind.phone.ui.start.StartScreen
import com.hivemind.phone.ui.start.StartViewModel
import com.hivemind.phone.ui.views.OpenView
import com.hivemind.phone.ui.views.ViewScreen
import com.hivemind.phone.ui.views.ViewViewModel
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

/** The screens, as entries of the back stack: saved with it, so a restored app opens where it was. */
@Serializable
sealed interface Route : NavKey {
    @Serializable
    data object Home : Route

    @Serializable
    data object Pair : Route

    @Serializable
    data class Agent(val device: String, val workspace: String, val tile: String) : Route {
        val ref get() = AgentRef(device, workspace, tile)
    }

    @Serializable
    data class Diff(val device: String, val workspace: String, val tile: String) : Route {
        val ref get() = AgentRef(device, workspace, tile)
    }

    @Serializable
    data object Start : Route

    /** A community view (§6.1), as Views offered it: its page, from its computer, on a workspace there. */
    @Serializable
    data class View(
        val device: String,
        val deviceName: String,
        val workspace: String,
        val id: String,
        val name: String,
        val page: String,
    ) : Route {
        val open get() = OpenView(device, deviceName, workspace, id, name, page)
    }
}

private fun AgentRef.agent() = Route.Agent(device, workspace, tile)

/**
 * The app's screens. Each entry keeps its own view models, so leaving an agent's screen stops
 * watching its terminal. A phone paired with nothing opens on Pair; a notification about an agent,
 * [opens], on its screen, over the rest.
 */
@Composable
fun PhoneNav(core: PhoneCore, opens: Flow<AgentRef>) {
    val first: Route = if (core.feed.overview.value.devices.isEmpty()) Route.Pair else Route.Home
    val stack = rememberNavBackStack(first)
    LaunchedEffect(opens) {
        opens.collect { agent ->
            val route = agent.agent()
            if (stack.lastOrNull() != route) stack.add(route)
        }
    }
    NavDisplay(
        backStack = stack,
        onBack = { stack.removeLastOrNull() },
        entryDecorators = listOf(
            rememberSaveableStateHolderNavEntryDecorator(),
            rememberViewModelStoreNavEntryDecorator(),
        ),
        entryProvider = entryProvider {
            entry<Route.Home> {
                HomeScreen(
                    core,
                    onOpen = { stack.add(it.agent()) },
                    onStart = { stack.add(Route.Start) },
                    onPair = { stack.add(Route.Pair) },
                    onOpenView = { row ->
                        stack.add(
                            Route.View(row.place.device, row.place.deviceName, row.place.workspace, row.view.id, row.view.name, row.view.page),
                        )
                    },
                )
            }
            entry<Route.Pair> {
                PairScreen(
                    viewModel { PairViewModel(core.phone) },
                    onDone = {
                        // Paired from Devices: back to it. Paired on first launch: home.
                        stack.removeLastOrNull()
                        if (stack.isEmpty()) stack.add(Route.Home)
                    },
                )
            }
            entry<Route.Agent> { route ->
                AgentScreen(
                    viewModel { AgentViewModel(core.phone, core.feed.overview, route.ref) },
                    onBack = { stack.removeLastOrNull() },
                    onDiff = { stack.add(Route.Diff(route.device, route.workspace, route.tile)) },
                    onClosed = { stack.removeLastOrNull() },
                )
            }
            entry<Route.Diff> { route ->
                DiffScreen(viewModel { DiffViewModel(core.phone, route.ref) }, onBack = { stack.removeLastOrNull() })
            }
            entry<Route.View> { route ->
                ViewScreen(viewModel { ViewViewModel(core.phone, route.open) }, onBack = { stack.removeLastOrNull() })
            }
            entry<Route.Start> {
                StartScreen(
                    viewModel { StartViewModel(core.phone, core.feed.overview) },
                    onBack = { stack.removeLastOrNull() },
                    onStarted = { agent ->
                        stack.removeLastOrNull()
                        stack.add(agent.agent())
                    },
                )
            }
        },
    )
}

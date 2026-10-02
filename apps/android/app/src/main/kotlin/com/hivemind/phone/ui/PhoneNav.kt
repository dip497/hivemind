package com.hivemind.phone.ui

import androidx.compose.runtime.Composable
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
}

private fun AgentRef.agent() = Route.Agent(device, workspace, tile)

/**
 * The app's screens. Each entry keeps its own view models, so leaving an agent's screen stops
 * watching its terminal. A phone paired with nothing opens on Pair.
 */
@Composable
fun PhoneNav(core: PhoneCore) {
    val first: Route = if (core.feed.overview.value.devices.isEmpty()) Route.Pair else Route.Home
    val stack = rememberNavBackStack(first)
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

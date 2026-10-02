package com.hivemind.phone.ui.start

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.Start
import com.hivemind.phone.core.StartProgram
import com.hivemind.phone.core.Startable
import com.hivemind.phone.ui.common.CoreCalls
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** A workspace on one of the person's devices: where an agent can be started. */
data class Place(val device: String, val deviceName: String, val workspace: String, val workspaceName: String)

/** The workspaces the person's devices hold, device by device, as the core lists them. */
fun placesOf(overview: Overview): List<Place> {
    val names = overview.devices.associate { it.id to it.name }
    return overview.workspaces.map { Place(it.device, names[it.device] ?: it.device, it.id, it.name) }
}

sealed interface Choices {
    data object Loading : Choices

    data class Ready(val startable: Startable) : Choices

    data class Failed(val message: String) : Choices
}

/** Starting an agent (design §6.6): device, workspace, folder, agent with its options, prompt. */
class StartViewModel(private val phone: Phone, overview: StateFlow<Overview>) : ViewModel() {
    val places: StateFlow<List<Place>> = overview.map(::placesOf)
        .stateIn(viewModelScope, SharingStarted.Eagerly, placesOf(overview.value))

    /** The device chosen, by its id. */
    var device: String? by mutableStateOf(null)
        private set

    var place: Place? by mutableStateOf(null)
        private set

    /** What the chosen workspace's host says may be started there, and in which folders. */
    var choices: Choices? by mutableStateOf(null)
        private set

    /** The folder (frame) to start in: the workspace's first until another is chosen, as the host takes none to mean. */
    var frame: String? by mutableStateOf(null)

    var program: StartProgram? by mutableStateOf(null)
        private set

    /** The chosen value of each of the program's options, by the option's id (`model`, `mode`). */
    val options = mutableStateMapOf<String, String>()

    var prompt by mutableStateOf("")

    val calls = CoreCalls(viewModelScope)
    private var asking: Job? = null

    /** Chooses a device; its workspace too, when it has only one. */
    fun chooseDevice(device: String) {
        this.device = device
        val there = places.value.filter { it.device == device }
        if (there.size == 1) {
            choose(there.single())
        } else {
            asking?.cancel()
            place = null
            choices = null
        }
    }

    fun choose(place: Place) {
        device = place.device
        this.place = place
        choices = Choices.Loading
        frame = null
        program = null
        options.clear()
        asking?.cancel()
        asking = viewModelScope.launch {
            choices = try {
                phone.startable(place.device, place.workspace).let { startable ->
                    frame = startable.frames.firstOrNull()?.id
                    Choices.Ready(startable)
                }
            } catch (e: PhoneException) {
                Choices.Failed(e.message.orEmpty())
            }
        }
    }

    fun choose(program: StartProgram) {
        this.program = program
        options.clear()
    }

    /** Starts the agent as chosen, and hands [started] the new agent. The phone's lock is asked first. */
    fun start(started: (AgentRef) -> Unit) {
        val place = place ?: return
        val program = program ?: return
        val start = Start(
            program = program.id,
            frame = frame,
            prompt = prompt.trim().ifEmpty { null },
            model = options["model"]?.trim()?.ifEmpty { null },
            mode = options["mode"]?.trim()?.ifEmpty { null },
        )
        calls.launch(place, { phone.start(place.device, place.workspace, start) }, started)
    }
}

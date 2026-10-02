package com.hivemind.phone.ui.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.ui.common.CoreCalls
import com.hivemind.phone.ui.common.Notice
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** Every agent, by device and then by workspace (design §6.3). */
data class AgentsState(val devices: List<DeviceAgents>) {
    data class DeviceAgents(val id: String, val name: String, val reachable: Boolean, val workspaces: List<WorkspaceAgents>)

    data class WorkspaceAgents(val id: String, val name: String, val agents: List<Agent>)

    companion object {
        /** Grouped in the order the core lists them: by device, then workspace, then name. */
        fun of(overview: Overview): AgentsState {
            val reachable = overview.devices.associate { it.id to it.reachable }
            return AgentsState(
                overview.agents.groupBy { it.at.device }.map { (device, agents) ->
                    DeviceAgents(
                        id = device,
                        name = agents.first().deviceName,
                        reachable = reachable[device] ?: false,
                        workspaces = agents.groupBy { it.at.workspace }.map { (workspace, inIt) ->
                            WorkspaceAgents(workspace, inIt.first().workspaceName, inIt)
                        },
                    )
                },
            )
        }
    }
}

class AgentsViewModel(private val phone: Phone, overview: StateFlow<Overview>) : ViewModel() {
    val state: StateFlow<AgentsState> = overview.map(AgentsState::of)
        .stateIn(viewModelScope, SharingStarted.Eagerly, AgentsState.of(overview.value))

    val calls = CoreCalls(viewModelScope)

    /** Ends [agent]'s turn: the keys its manifest says interrupt it. */
    fun stop(agent: Agent) = calls.launch(agent.at, { phone.interrupt(agent.at) }) { stopped ->
        if (!stopped) calls.tell(Notice.NotStopped)
    }

    /** Ends [agent]'s session and takes its tile off the board. The phone's lock is asked first. */
    fun close(agent: Agent) = calls.launch(agent.at, { phone.closeAgent(agent.at) }) { closed ->
        if (!closed) calls.tell(Notice.AlreadyClosed)
    }
}

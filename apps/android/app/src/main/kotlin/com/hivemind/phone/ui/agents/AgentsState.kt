package com.hivemind.phone.ui.agents

import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.Overview

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

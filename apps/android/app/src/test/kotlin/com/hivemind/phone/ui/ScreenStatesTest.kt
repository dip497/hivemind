package com.hivemind.phone.ui

import com.hivemind.phone.DESK
import com.hivemind.phone.MINUTE
import com.hivemind.phone.agent
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.device
import com.hivemind.phone.overview
import com.hivemind.phone.ui.agents.AgentsState
import com.hivemind.phone.ui.needs.NeedsState
import com.hivemind.phone.ui.start.Place
import com.hivemind.phone.ui.start.placesOf
import com.hivemind.phone.waiting
import com.hivemind.phone.workspace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What each screen's view model makes of the core's overview (design §5.2, §6). */
class ScreenStatesTest {
    @Test
    fun `Needs you counts as away only a device found away, not one still being dialled`() {
        val needs = listOf(
            agent("t1", device = "laptop-id", waiting = waiting(WaitKind.PERMISSION, since = 5 * MINUTE)),
            agent("t2", waiting = waiting(WaitKind.QUESTION, since = 9 * MINUTE)),
        )
        val state = NeedsState.of(
            overview(
                needs = needs,
                working = 4,
                devices = listOf(
                    device(DESK, "desk", reachable = false, awaySince = 20 * MINUTE, heardAt = 15 * MINUTE),
                    device("laptop-id", "laptop", reachable = false),
                    device("host-id", "host"),
                ),
            ),
        )

        assertEquals(listOf("desk"), state.away.map { it.name })
        assertEquals(needs, state.needs)
        assertEquals(4, state.working)
        assertFalse(state.lastHeard(needs[0]))
        assertTrue(state.lastHeard(needs[1]))
    }

    @Test
    fun `Agents groups by device, then workspace, in the order the core lists them`() {
        val state = AgentsState.of(
            overview(
                agents = listOf(
                    agent("t1", name = "zed", workspace = "ws-2", workspaceName = "site"),
                    agent("t2", name = "ada", workspace = "ws-2", workspaceName = "site"),
                    agent("t3", name = "bo", workspace = "ws-1", workspaceName = "hivemind"),
                    agent("t4", name = "cy", device = "laptop-id", deviceName = "laptop", state = AgentState.IDLE),
                ),
                devices = listOf(device(DESK, "desk"), device("laptop-id", "laptop", reachable = false)),
            ),
        )

        assertEquals(listOf("desk" to true, "laptop" to false), state.devices.map { it.name to it.reachable })
        assertEquals(
            listOf(listOf("site" to listOf("zed", "ada"), "hivemind" to listOf("bo")), listOf("hivemind" to listOf("cy"))),
            state.devices.map { device -> device.workspaces.map { it.name to it.agents.map { agent -> agent.name } } },
        )
    }

    @Test
    fun `Start offers every workspace the person's devices hold, under the device's name`() {
        val places = placesOf(
            overview(
                agents = listOf(agent("t1", workspace = "ws-1", workspaceName = "hivemind")),
                devices = listOf(device(DESK, "desk"), device("laptop-id", "laptop", reachable = false)),
                workspaces = listOf(
                    workspace("ws-1", "hivemind"),
                    workspace("ws-2", "site", folder = "/home/priya/site"),
                    workspace("ws-9", "notes", device = "laptop-id"),
                ),
            ),
        )

        assertEquals(
            listOf(
                Place(DESK, "desk", "ws-1", "hivemind"),
                Place(DESK, "desk", "ws-2", "site"),
                Place("laptop-id", "laptop", "ws-9", "notes"),
            ),
            places,
        )
    }
}

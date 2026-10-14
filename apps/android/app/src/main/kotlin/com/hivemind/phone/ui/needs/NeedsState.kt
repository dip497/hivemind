package com.hivemind.phone.ui.needs

import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.Device
import com.hivemind.phone.core.Overview

/** What waits on the person, at the top of Home (design §6.2). */
data class NeedsState(
    /** What waits on the person, the longest-waiting first, as the core orders it. */
    val needs: List<Agent>,
    /** How many agents are at work meanwhile. */
    val working: Int,
    /** The person's devices found away: shown with when they last answered, and what they last said. */
    val away: List<Device>,
    /** The person's devices not found away that have not said yet what waits there: until each has,
     *  that nothing waits is not known. */
    val asking: List<Device>,
) {
    /** Whether [agent] is as its device last said, that device being away now. */
    fun lastHeard(agent: Agent): Boolean = away.any { it.id == agent.at.device }

    companion object {
        fun of(overview: Overview) = NeedsState(
            needs = overview.needs,
            working = overview.working.toInt(),
            away = overview.devices.filter { !it.reachable && it.awaySince != null },
            asking = overview.devices.filter { it.answeredAt == null && it.awaySince == null },
        )
    }
}

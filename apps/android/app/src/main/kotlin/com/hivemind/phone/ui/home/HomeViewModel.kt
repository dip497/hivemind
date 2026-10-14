package com.hivemind.phone.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.HomeShown
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.ui.agents.AgentsState
import com.hivemind.phone.ui.common.CoreCalls
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.needs.NeedsState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/** What Home is asked to show by: the words searched for, and the machine chosen. */
data class HomeFilter(val query: String = "", val machine: String? = null)

/**
 * Home (spec/home.md, the desktop's Layers panel): what waits on the person; then on each computer
 * the phone reached, what is at work, the pinned and its tree; then the agents of a device whose Home
 * has not come yet, as the overview lists them.
 */
data class HomeState(
    val needs: NeedsState,
    val homes: List<HomeShown>,
    val elsewhere: AgentsState,
    /** Every agent of the overview, by where it is: what a tile's row acts on. */
    val agents: Map<AgentRef, Agent>,
    val filter: HomeFilter,
) {
    companion object {
        fun of(overview: Overview, homes: List<HomeShown>, filter: HomeFilter): HomeState {
            val homed = homes.map { it.device }.toSet()
            val elsewhere = AgentsState.of(overview).devices.filter { it.id !in homed }
            return HomeState(
                needs = NeedsState.of(overview),
                homes = homes,
                elsewhere = AgentsState(elsewhere),
                agents = overview.agents.associateBy { it.at },
                filter = filter,
            )
        }
    }
}

class HomeViewModel(private val phone: Phone, overview: StateFlow<Overview>) : ViewModel() {
    private val filter = MutableStateFlow(HomeFilter())

    // The core tells of Home's changes as it does the overview's: each overview pulls Home again.
    val state: StateFlow<HomeState> = combine(overview, filter) { o, f -> HomeState.of(o, phone.home(f.query, f.machine), f) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, HomeState.of(overview.value, phone.home("", null), HomeFilter()))

    val calls = CoreCalls(viewModelScope)

    fun search(query: String) {
        filter.value = filter.value.copy(query = query)
    }

    /** Shows only [machine]; the one already chosen, chosen again, shows every machine. */
    fun choose(machine: String) {
        filter.value = filter.value.copy(machine = machine.takeIf { it != filter.value.machine })
    }

    /** Answers what [agent] waits on: that wait, named by when it began, and only once (design §3.7). */
    fun answer(agent: Agent, answer: Answer) {
        val since = agent.waiting?.since ?: return
        calls.launch(agent.at, { phone.answer(agent.at, since, answer) }) { answered ->
            if (!answered) calls.tell(Notice.AlreadyAnswered)
        }
    }

    /** Ends [agent]'s turn: the keys its manifest says interrupt it. */
    fun stop(agent: Agent) = calls.launch(agent.at, { phone.interrupt(agent.at) }) { stopped ->
        if (!stopped) calls.tell(Notice.NotStopped)
    }

    /** Ends [agent]'s session and takes its tile off the board. The phone's lock is asked first. */
    fun close(agent: Agent) = calls.launch(agent.at, { phone.closeAgent(agent.at) }) { closed ->
        if (!closed) calls.tell(Notice.AlreadyClosed)
    }
}

package com.hivemind.phone.ui.needs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.Answer
import com.hivemind.phone.core.Device
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.ui.common.CoreCalls
import com.hivemind.phone.ui.common.Notice
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** What the Needs you tab shows (design §6.2). */
data class NeedsState(
    /** What waits on the person, the longest-waiting first, as the core orders it. */
    val needs: List<Agent>,
    /** How many agents are at work meanwhile. */
    val working: Int,
    /** The person's devices found away: shown with when they last answered, and what they last said. */
    val away: List<Device>,
) {
    /** Whether [agent] is as its device last said, that device being away now. */
    fun lastHeard(agent: Agent): Boolean = away.any { it.id == agent.at.device }

    companion object {
        fun of(overview: Overview) = NeedsState(
            needs = overview.needs,
            working = overview.working.toInt(),
            away = overview.devices.filter { !it.reachable && it.awaySince != null },
        )
    }
}

class NeedsViewModel(private val phone: Phone, overview: StateFlow<Overview>) : ViewModel() {
    val state: StateFlow<NeedsState> = overview.map(NeedsState::of)
        .stateIn(viewModelScope, SharingStarted.Eagerly, NeedsState.of(overview.value))

    val calls = CoreCalls(viewModelScope)

    /** Answers what [agent] waits on: that wait, named by when it began, and only once (design §3.7). */
    fun answer(agent: Agent, answer: Answer) {
        val since = agent.waiting?.since ?: return
        calls.launch(agent.at, { phone.answer(agent.at, since, answer) }) { answered ->
            if (!answered) calls.tell(Notice.AlreadyAnswered)
        }
    }
}

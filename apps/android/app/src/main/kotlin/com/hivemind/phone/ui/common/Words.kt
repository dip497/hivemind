package com.hivemind.phone.ui.common

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import com.hivemind.phone.R
import com.hivemind.phone.core.Agent
import com.hivemind.phone.core.AgentState
import com.hivemind.phone.core.WaitKind
import com.hivemind.phone.ui.theme.LocalStateColors
import kotlinx.coroutines.delay

/** The time now, refreshed often enough to say how long ago something was. */
@Composable
fun rememberNow(): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(15_000)
            value = System.currentTimeMillis()
        }
    }
    return now
}

/** How long it has been since [since] (ms since the epoch), as the lists say it: now, 5 min, 2 h, 3 d. */
@Composable
fun sinceText(since: ULong, now: Long): String {
    val seconds = ((now - since.toLong()) / 1000).coerceAtLeast(0)
    return when {
        seconds < 60 -> stringResource(R.string.ago_now)
        seconds < 3_600 -> stringResource(R.string.ago_minutes, seconds / 60)
        seconds < 86_400 -> stringResource(R.string.ago_hours, seconds / 3_600)
        else -> stringResource(R.string.ago_days, seconds / 86_400)
    }
}

@Composable
fun AgentState.label(): String = stringResource(
    when (this) {
        AgentState.IDLE -> R.string.state_idle
        AgentState.WORKING -> R.string.state_working
        AgentState.WAITING -> R.string.state_waiting
        AgentState.DONE -> R.string.state_done
        AgentState.FAILED -> R.string.state_failed
        AgentState.INTERRUPTED -> R.string.state_interrupted
        AgentState.LIMITED -> R.string.state_limited
        AgentState.EXITED -> R.string.state_exited
    },
)

@Composable
fun AgentState.color(): Color {
    val colors = LocalStateColors.current
    return when (this) {
        AgentState.WAITING -> colors.waiting
        AgentState.WORKING -> colors.working
        AgentState.DONE -> colors.done
        AgentState.FAILED, AgentState.LIMITED -> colors.failed
        AgentState.IDLE, AgentState.INTERRUPTED, AgentState.EXITED -> colors.quiet
    }
}

@Composable
fun WaitKind.label(): String = stringResource(
    when (this) {
        WaitKind.PERMISSION -> R.string.wait_permission
        WaitKind.QUESTION -> R.string.wait_question
        WaitKind.PLAN -> R.string.wait_plan
        WaitKind.OTHER -> R.string.wait_other
    },
)

@Composable
fun Notice.text(): String = when (this) {
    is Notice.Failed -> message.ifEmpty { stringResource(R.string.notice_failed) }
    Notice.AlreadyAnswered -> stringResource(R.string.notice_already_answered)
    Notice.NotRunning -> stringResource(R.string.notice_not_running)
    Notice.NotStopped -> stringResource(R.string.notice_not_stopped)
    Notice.AlreadyClosed -> stringResource(R.string.notice_already_closed)
    Notice.AlreadyUnpaired -> stringResource(R.string.notice_already_unpaired)
    Notice.NoLock -> stringResource(R.string.notice_no_lock)
}

/**
 * Whether Stop applies: the agent is in a turn, working or waiting, and its manifest says how to
 * interrupt it (spec/agents.md, "Stopping").
 */
val Agent.stoppable: Boolean get() = canInterrupt && (state == AgentState.WORKING || state == AgentState.WAITING)

package com.hivemind.phone.ui.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.push.PushState
import com.hivemind.phone.ui.common.AllowNotifications
import org.unifiedpush.android.connector.FailedReason

/**
 * Being told while the app is away (P6): whether the phone may show notifications, and where the
 * person's devices tell it, as [state] says: through which push server, who took it, who was away,
 * or why not; and what the person can do about it.
 */
@Composable
fun PushCard(state: PushState, onChoose: () -> Unit, onAgain: () -> Unit, modifier: Modifier = Modifier) {
    if (state == PushState.Unpaired) return
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.push_title), style = MaterialTheme.typography.titleMedium)
        AllowNotifications()
        for (line in state.words()) {
            Text(line, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        when (state) {
            PushState.ToChoose -> OutlinedButton(onClick = onChoose) { Text(stringResource(R.string.action_push_choose)) }
            is PushState.NotTold, is PushState.RegistrationFailed, PushState.Dropped ->
                OutlinedButton(onClick = onAgain) { Text(stringResource(R.string.action_try_again)) }
            else -> Unit
        }
    }
}

@Composable
private fun PushState.words(): List<String> = when (this) {
    PushState.Unpaired -> emptyList()
    PushState.NoDistributor -> listOf(stringResource(R.string.push_none))
    PushState.ToChoose -> listOf(stringResource(R.string.push_to_choose))
    is PushState.Registering -> listOf(stringResource(R.string.push_registering, distributor))
    is PushState.RegistrationFailed -> listOf(
        stringResource(
            when (reason) {
                FailedReason.NETWORK -> R.string.push_failed_network
                FailedReason.ACTION_REQUIRED -> R.string.push_failed_action
                FailedReason.VAPID_REQUIRED -> R.string.push_failed_vapid
                FailedReason.INTERNAL_ERROR -> R.string.push_failed_internal
            },
        ),
    )
    PushState.Dropped -> listOf(stringResource(R.string.push_dropped))
    is PushState.NotTold -> listOf(stringResource(R.string.push_not_told, why))
    is PushState.Told -> buildList {
        val via = told.via
        add(if (via != null) stringResource(R.string.push_via, via) else stringResource(R.string.push_direct))
        told.unregistered?.let { add(stringResource(R.string.push_server_refused, it)) }
        if (told.told.isEmpty() && told.away.isEmpty()) add(stringResource(R.string.push_told_nobody))
        if (told.told.isNotEmpty()) add(stringResource(R.string.push_told, told.told.joinToString(", ")))
        if (told.away.isNotEmpty()) add(stringResource(R.string.push_away, told.away.joinToString(", ")))
    }
}

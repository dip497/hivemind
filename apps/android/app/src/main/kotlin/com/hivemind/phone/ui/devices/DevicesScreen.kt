package com.hivemind.phone.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.Device
import com.hivemind.phone.core.DeviceKind
import com.hivemind.phone.push.PushState
import com.hivemind.phone.ui.common.Dot
import com.hivemind.phone.ui.common.Hairline
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.personColor

/**
 * Whose the phone is; each device, reachable or away; unpair one, [onUnpair] asking first (see
 * [UnpairDialog]); pair another (design §6.7); and how the devices tell the phone while the app is
 * away, [push] (P6). Items of the Settings list.
 */
fun LazyListScope.devicesItems(
    state: DevicesState,
    busy: Set<Any>,
    now: Long,
    onUnpair: (Device) -> Unit,
    onPair: () -> Unit,
    push: PushState,
    onChoosePush: () -> Unit,
    onPushAgain: () -> Unit,
) {
    state.person?.let { person ->
        item(key = "person") {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                personColor(person.color)?.let { Box(Modifier.size(12.dp).background(it, CircleShape)) }
                Text(
                    stringResource(R.string.devices_whose, person.name),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
    items(state.devices, key = { it.id }) { device ->
        DeviceRow(device, device.id in busy, now, onUnpair = { onUnpair(device) })
    }
    item(key = "pair") {
        OutlinedButton(onClick = onPair, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(stringResource(R.string.action_pair_another))
        }
    }
    item(key = "push") {
        Hairline(Modifier.padding(vertical = 8.dp))
        PushCard(push, onChoose = onChoosePush, onAgain = onPushAgain, modifier = Modifier.padding(16.dp))
    }
}

/** Asks before [device] is unpaired; [onUnpair] once the person says so. */
@Composable
fun UnpairDialog(device: Device, onUnpair: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.unpair_title, device.name)) },
        text = { Text(stringResource(R.string.unpair_body)) },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                onUnpair()
            }) { Text(stringResource(R.string.action_unpair)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } },
    )
}

@Composable
private fun DeviceRow(device: Device, busy: Boolean, now: Long, onUnpair: () -> Unit) {
    val colors = LocalStateColors.current
    Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Dot(if (device.reachable) colors.done else colors.quiet, filled = device.reachable)
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(device.name, style = MaterialTheme.typography.bodyLarge)
            val kind = stringResource(if (device.kind == DeviceKind.HOST) R.string.device_host else R.string.device_computer)
            val heard = device.heardAt
            Text(
                when {
                    device.reachable -> stringResource(R.string.device_reachable, kind)
                    // Not answering, and not yet found away: the core is still dialling it.
                    device.awaySince == null -> stringResource(R.string.device_connecting, kind)
                    heard != null -> stringResource(R.string.device_away_heard, kind, sinceText(heard, now))
                    else -> stringResource(R.string.device_away, kind)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(
            onClick = onUnpair,
            enabled = !busy,
            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        ) { Text(stringResource(R.string.action_unpair)) }
    }
}

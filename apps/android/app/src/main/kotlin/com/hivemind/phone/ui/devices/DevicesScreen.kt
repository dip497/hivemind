package com.hivemind.phone.ui.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R
import com.hivemind.phone.core.Device
import com.hivemind.phone.core.DeviceKind
import com.hivemind.phone.ui.common.sinceText
import com.hivemind.phone.ui.theme.LocalStateColors
import com.hivemind.phone.ui.theme.personColor

/** Whose the phone is; each device, reachable or away; unpair one; pair another (design §6.7). */
@Composable
fun DevicesList(
    state: DevicesState,
    busy: Set<Any>,
    now: Long,
    onUnpair: (Device) -> Unit,
    onPair: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var unpairing by rememberSaveable { mutableStateOf<String?>(null) }
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        state.person?.let { person ->
            item(key = "person") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    personColor(person.color)?.let { Box(Modifier.size(14.dp).background(it, CircleShape)) }
                    Text(
                        stringResource(R.string.devices_whose, person.name),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
        }
        items(state.devices, key = { it.id }) { device ->
            DeviceRow(device, device.id in busy, now, onUnpair = { unpairing = device.id })
        }
        item(key = "pair") {
            OutlinedButton(onClick = onPair, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_pair_another))
            }
        }
    }
    val device = state.devices.firstOrNull { it.id == unpairing }
    if (device != null) {
        AlertDialog(
            onDismissRequest = { unpairing = null },
            title = { Text(stringResource(R.string.unpair_title, device.name)) },
            text = { Text(stringResource(R.string.unpair_body)) },
            confirmButton = {
                TextButton(onClick = {
                    unpairing = null
                    onUnpair(device)
                }) { Text(stringResource(R.string.action_unpair)) }
            },
            dismissButton = { TextButton(onClick = { unpairing = null }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

@Composable
private fun DeviceRow(device: Device, busy: Boolean, now: Long, onUnpair: () -> Unit) {
    val colors = LocalStateColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(10.dp).background(if (device.reachable) colors.done else colors.quiet, CircleShape))
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
        TextButton(onClick = onUnpair, enabled = !busy) { Text(stringResource(R.string.action_unpair)) }
    }
}

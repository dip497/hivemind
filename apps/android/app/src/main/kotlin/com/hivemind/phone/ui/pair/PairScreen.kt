package com.hivemind.phone.ui.pair

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.hivemind.phone.R
import com.hivemind.phone.core.Paired
import com.hivemind.phone.ui.theme.personColor
import kotlinx.coroutines.launch

/**
 * Pair with hivemind (design §6.1): the camera reads the QR code the computer shows (Settings →
 * Devices → Pair a phone), or the link is pasted; then whose the phone is now, in their name and
 * colour.
 */
@Composable
fun PairScreen(vm: PairViewModel, onDone: () -> Unit) {
    Scaffold { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineSmall)
            when (val state = vm.state) {
                is PairState.Done -> Paired(state.paired, onDone)
                else -> Pairing(vm, state)
            }
        }
    }
}

@Composable
private fun Pairing(vm: PairViewModel, state: PairState) {
    val context = LocalContext.current
    var camera by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it }
    var link by rememberSaveable { mutableStateOf("") }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val pairing = state is PairState.Pairing

    // The camera is optional (an emulator, a Chromebook, some tablets have none): without one, or
    // with one that cannot be opened, the link is pasted.
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    var cameraFailed by rememberSaveable { mutableStateOf(false) }

    Text(stringResource(if (hasCamera) R.string.pair_how else R.string.pair_how_paste), style = MaterialTheme.typography.bodyMedium)
    when {
        !hasCamera -> Unit
        cameraFailed -> Text(stringResource(R.string.pair_camera_unavailable), color = MaterialTheme.colorScheme.onSurfaceVariant)
        camera -> QrScanner(
            onCode = vm::scanned,
            onUnavailable = { cameraFailed = true },
            modifier = Modifier.fillMaxWidth().aspectRatio(1f).clip(MaterialTheme.shapes.large).testTag("pair-camera"),
        )
        else -> OutlinedButton(onClick = { askCamera.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.action_allow_camera))
        }
    }
    OutlinedTextField(
        value = link,
        onValueChange = { link = it },
        label = { Text(stringResource(R.string.pair_link)) },
        singleLine = true,
        enabled = !pairing,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { if (link.isNotBlank()) vm.pair(link) }),
        trailingIcon = {
            TextButton(onClick = {
                scope.launch {
                    clipboard.getClipEntry()?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.let { link = it.toString() }
                }
            }) { Text(stringResource(R.string.action_paste)) }
        },
        modifier = Modifier.fillMaxWidth().testTag("pair-link"),
    )
    Button(
        onClick = { vm.pair(link) },
        enabled = link.isNotBlank() && !pairing,
        modifier = Modifier.fillMaxWidth().testTag("pair-button"),
    ) { Text(stringResource(R.string.action_pair)) }
    when (state) {
        is PairState.Pairing -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            val with = state.with
            Text(if (with != null) stringResource(R.string.pair_pairing_with, with.name) else stringResource(R.string.pair_pairing))
        }
        is PairState.Failed -> Text(
            state.message.ifEmpty { stringResource(R.string.notice_failed) },
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.testTag("pair-error"),
        )
        else -> Unit
    }
}

@Composable
private fun Paired(paired: Paired, onDone: () -> Unit) {
    val person = paired.person
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        personColor(person?.color)?.let { Box(Modifier.size(20.dp).background(it, CircleShape)) }
        Text(
            if (person != null) stringResource(R.string.pair_whose, person.name) else stringResource(R.string.pair_with, paired.name),
            style = MaterialTheme.typography.titleMedium,
        )
    }
    if (person != null) Text(stringResource(R.string.pair_with, paired.name), color = MaterialTheme.colorScheme.onSurfaceVariant)
    Button(onClick = onDone, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.action_continue)) }
}

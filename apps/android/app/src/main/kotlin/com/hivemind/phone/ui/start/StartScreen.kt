package com.hivemind.phone.ui.start

import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.TextButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.hivemind.phone.R
import com.hivemind.phone.core.AgentRef
import com.hivemind.phone.core.Photo
import com.hivemind.phone.core.StartOption
import com.hivemind.phone.ui.common.GroupLabel
import com.hivemind.phone.ui.common.LocalPhoneLock
import com.hivemind.phone.ui.common.Notice
import com.hivemind.phone.ui.common.NoticeEffect
import com.hivemind.phone.ui.common.PillChip
import com.hivemind.phone.ui.common.RaisedCard

/**
 * Device, then workspace, then folder, then agent (with its model and mode, when it has them), as
 * rows of chips; then a prompt in a raised card with Start; Start asks the phone's lock, and opens
 * the new agent's screen (design §6.6).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun StartScreen(vm: StartViewModel, onBack: () -> Unit, onStarted: (AgentRef) -> Unit) {
    val places by vm.places.collectAsStateWithLifecycle()
    val lock = LocalPhoneLock.current
    val snackbar = remember { SnackbarHostState() }
    NoticeEffect(vm.calls, snackbar)
    val lockTitle = stringResource(R.string.lock_start_title, vm.program?.label.orEmpty())
    val lockSubtitle = stringResource(R.string.lock_subtitle)
    val resolver = LocalContext.current.contentResolver
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(PHOTOS_MAX)) { vm.addPhotos(resolver, it) }

    val colors = MaterialTheme.colorScheme
    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.background, scrolledContainerColor = colors.background),
                title = { Text(stringResource(R.string.start_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.action_back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (places.isEmpty()) {
                Text(stringResource(R.string.start_no_places), color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            Heading(stringResource(R.string.start_device))
            val device = vm.device
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (place in places.distinctBy { it.device }) {
                    PillChip(place.device == device, onClick = { vm.chooseDevice(place.device) }, label = place.deviceName)
                }
            }
            if (device == null) return@Column

            Heading(stringResource(R.string.start_workspace))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (place in places.filter { it.device == device }) {
                    PillChip(place == vm.place, onClick = { vm.choose(place) }, label = place.workspaceName)
                }
            }

            when (val choices = vm.choices) {
                null -> Unit
                Choices.Loading -> CircularProgressIndicator()
                is Choices.Failed -> Text(choices.message, color = MaterialTheme.colorScheme.error)
                is Choices.Ready -> {
                    val startable = choices.startable
                    if (startable.frames.isNotEmpty()) {
                        Heading(stringResource(R.string.start_folder))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (frame in startable.frames) {
                                PillChip(
                                    vm.frame == frame.id,
                                    onClick = { vm.frame = frame.id },
                                    label = stringResource(R.string.where, frame.name, frame.machine),
                                )
                            }
                        }
                    }
                    Heading(stringResource(R.string.start_agent))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (program in startable.programs) {
                            PillChip(vm.program?.id == program.id, onClick = { vm.choose(program) }, label = program.label)
                        }
                    }
                    vm.program?.options?.forEach { option -> OptionChoice(option, vm.options[option.id]) { vm.options[option.id] = it } }
                    RaisedCard(Modifier.padding(top = 8.dp)) {
                        TextField(
                            value = vm.prompt,
                            onValueChange = { vm.prompt = it },
                            placeholder = { Text(stringResource(R.string.start_prompt)) },
                            minLines = 4,
                            textStyle = MaterialTheme.typography.bodyLarge,
                            colors = TextFieldDefaults.colors(
                                focusedContainerColor = Color.Transparent,
                                unfocusedContainerColor = Color.Transparent,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                                focusedPlaceholderColor = colors.tertiary,
                                unfocusedPlaceholderColor = colors.tertiary,
                            ),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (vm.photos.isNotEmpty()) {
                            Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                vm.photos.forEachIndexed { i, photo -> PhotoThumb(photo) { vm.photos.removeAt(i) } }
                            }
                        }
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(
                                onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                                enabled = vm.photos.size < PHOTOS_MAX,
                                modifier = Modifier.testTag("start-photos"),
                            ) { Text(stringResource(R.string.start_add_photo)) }
                            Box(Modifier.weight(1f))
                            Button(
                                onClick = {
                                    val asked = lock.ask(lockTitle, lockSubtitle) { vm.start(onStarted) }
                                    if (!asked) vm.calls.tell(Notice.NoLock)
                                },
                                enabled = vm.program != null && vm.calls.busy.isEmpty(),
                            ) {
                                Text(stringResource(R.string.action_start))
                                Icon(painterResource(R.drawable.ic_send_up), null, modifier = Modifier.padding(start = 6.dp).size(18.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Heading(text: String) = GroupLabel(text, Modifier.padding(top = 6.dp))

/** One of a program's options: its values to pick from, or free text when it lists none. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionChoice(option: StartOption, chosen: String?, onChoose: (String) -> Unit) {
    Heading(option.label)
    if (option.values.isEmpty()) {
        OutlinedTextField(
            value = chosen.orEmpty(),
            onValueChange = onChoose,
            singleLine = true,
            shape = CircleShape,
            modifier = Modifier.fillMaxWidth(),
        )
    } else {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (value in option.values) {
                PillChip(chosen == value, onClick = { onChoose(value) }, label = value)
            }
        }
    }
}

/** A photo given with the prompt, small, with × to take it out. */
@Composable
private fun PhotoThumb(photo: Photo, onRemove: () -> Unit) {
    val image = remember(photo) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(photo.bytes, 0, photo.bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 256) sample *= 2
        BitmapFactory.decodeByteArray(photo.bytes, 0, photo.bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }
    Box(Modifier.size(64.dp).clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
        if (image != null) Image(image, null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        IconButton(onClick = onRemove, modifier = Modifier.align(Alignment.TopEnd).size(28.dp)) {
            Icon(
                Icons.Filled.Close,
                stringResource(R.string.action_remove_photo),
                tint = Color.White,
                modifier = Modifier.size(18.dp).background(Color.Black.copy(alpha = 0.5f), CircleShape).padding(2.dp),
            )
        }
    }
}

package com.hivemind.phone.ui.common

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.hivemind.phone.R

private fun allowed(context: Context) = Build.VERSION.SDK_INT < 33 ||
    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

/**
 * Asks to show notifications where being told what needs the person is the matter at hand (Devices,
 * and once paired), never as the app opens (Android 13+). Refused, it opens the system's settings
 * for them instead, where the person can change their mind. Nothing once they are allowed.
 */
@Composable
fun AllowNotifications(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var shown by remember { mutableStateOf(allowed(context)) }
    var refused by rememberSaveable { mutableStateOf(false) }
    // Changed in the system's settings meanwhile: read again as the screen comes back.
    LifecycleResumeEffect(context) {
        shown = allowed(context)
        onPauseOrDispose {}
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { given ->
        shown = given
        refused = !given
    }
    if (shown) return
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            stringResource(if (refused) R.string.notify_refused else R.string.notify_ask),
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedButton(
            onClick = {
                if (refused) {
                    context.startActivity(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                    )
                } else {
                    ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            },
        ) { Text(stringResource(if (refused) R.string.action_open_settings else R.string.action_allow_notifications)) }
    }
}

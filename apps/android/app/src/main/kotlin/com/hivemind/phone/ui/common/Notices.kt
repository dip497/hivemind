package com.hivemind.phone.ui.common

import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect

/** Shows a screen's notice once, as a snackbar, and marks it seen. */
@Composable
fun NoticeEffect(calls: CoreCalls, host: SnackbarHostState) {
    val notice = calls.notice ?: return
    val text = notice.text()
    LaunchedEffect(notice) {
        host.showSnackbar(text)
        calls.seen()
    }
}

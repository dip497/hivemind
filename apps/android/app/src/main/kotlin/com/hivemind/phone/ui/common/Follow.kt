package com.hivemind.phone.ui.common

import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.hivemind.phone.R

/**
 * A list that follows its newest item (design §6.4): until the person scrolls up, and again once
 * they are back at the bottom, by hand or by the newest-item button. Kept by what fills the list,
 * so that what it adds and the scroll that shows it land in one frame.
 */
@Stable
class Follow {
    val list = LazyListState()

    /** Whether the list keeps its newest item in view. */
    var on by mutableStateOf(true)

    /** The list now ends at [last]: shown while following, though not while the person moves it. */
    fun grew(last: Int) {
        if (on && last >= 0 && !list.isScrollInProgress) list.requestScrollToItem(last)
    }

    /** Back to the newest item, [last], following it again. */
    fun newest(last: Int) {
        on = true
        if (last >= 0) list.requestScrollToItem(last)
    }
}

/** The person scrolling up stops the following; being back at the bottom, after a drag or a fling, starts it again. */
@Composable
fun FollowTheNewest(follow: Follow) {
    val dragged by follow.list.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(dragged) {
        if (dragged) follow.on = false else if (!follow.list.canScrollForward) follow.on = true
    }
    LaunchedEffect(follow) {
        snapshotFlow { follow.list.canScrollForward }.collect { more -> if (!more) follow.on = true }
    }
}

/** Scrolled up: a button back to the newest item, [last] (read when it is tapped). */
@Composable
fun BoxScope.NewestButton(follow: Follow, last: () -> Int) {
    if (!follow.on) {
        SmallFloatingActionButton(
            onClick = { follow.newest(last()) },
            modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
        ) { Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.list_newest)) }
    }
}

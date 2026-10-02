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
 * so that what it adds and the scroll that shows it land in one frame. Following, the list rests
 * at an item its owner names, from the top: the chat at its last, which the list's end then
 * brings to the bottom; the terminal at the line that leaves its newest line the last in sight.
 */
@Stable
class Follow {
    val list = LazyListState()

    /** Whether the list keeps its newest item in view. */
    var on by mutableStateOf(true)

    /** The list changed, and rests at [at]: shown while following, though not while the person moves it. */
    fun grew(at: Int) {
        if (on && at >= 0 && !list.isScrollInProgress) list.requestScrollToItem(at)
    }

    /** Back to where the list rests, [at], following it again. */
    fun newest(at: Int) {
        on = true
        if (at >= 0) list.requestScrollToItem(at)
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

/** Scrolled up: a button back to where the list rests, [at] (read when it is tapped). */
@Composable
fun BoxScope.NewestButton(follow: Follow, at: () -> Int) {
    if (!follow.on) {
        SmallFloatingActionButton(
            onClick = { follow.newest(at()) },
            modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
        ) { Icon(Icons.Filled.KeyboardArrowDown, stringResource(R.string.list_newest)) }
    }
}

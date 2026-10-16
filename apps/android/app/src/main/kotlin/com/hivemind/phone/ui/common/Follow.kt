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
 * at an item its owner names: the chat, drawn from the bottom up ([newestFirst]), at its first;
 * the terminal at the line that leaves its newest line the last in sight.
 */
@Stable
class Follow(private val newestFirst: Boolean = false) {
    val list = LazyListState()

    /** Whether the list is at its newest end: the bottom of the screen, either way it is drawn. */
    val atNewest: Boolean get() = if (newestFirst) !list.canScrollBackward else !list.canScrollForward

    /** Whether the list keeps its newest item in view. */
    var on by mutableStateOf(true)

    /** Where the list was to rest when the person was moving it: shown once they let go, still following. */
    private var owed = -1

    /** The list changed, and rests at [at]: shown while following, though not while the person moves it. */
    fun grew(at: Int) {
        if (!on || at < 0) return
        if (list.isScrollInProgress) {
            owed = at
        } else {
            owed = -1
            list.requestScrollToItem(at)
        }
    }

    /** The list stopped moving: following, it goes where it was to rest meanwhile. */
    fun settled() {
        if (on && owed >= 0) list.requestScrollToItem(owed)
        owed = -1
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
        if (dragged) follow.on = false else if (follow.atNewest) follow.on = true
    }
    LaunchedEffect(follow) {
        snapshotFlow { follow.atNewest }.collect { newest ->
            if (newest) {
                follow.on = true
                follow.settled()
            }
        }
    }
    LaunchedEffect(follow) {
        snapshotFlow { follow.list.isScrollInProgress }.collect { moving -> if (!moving) follow.settled() }
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

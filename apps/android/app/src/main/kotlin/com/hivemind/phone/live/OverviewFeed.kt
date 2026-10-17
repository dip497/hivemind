package com.hivemind.phone.live

import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.OverviewListener
import com.hivemind.phone.core.Phone
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * What the phone shows, followed (design §5.2): the snapshot the core kept, at once, and each newer
 * one as the core tells of it, pulled at most once a frame. The one follower of the overview for the
 * whole app; every screen reads [overview].
 *
 * Made on the main thread.
 */
class OverviewFeed(private val phone: Phone) : OverviewListener {
    private val newest = MutableStateFlow(phone.overview())

    val overview: StateFlow<Overview> = newest.asStateFlow()

    // Before following: the core may tell of a change as soon as it is followed.
    private val pull = FramePull { newest.value = phone.overview() }

    // Kept for as long as the feed is: following stops when this is let go.
    private val following = phone.follow(this)

    override fun changed(revision: ULong) = pull.request()
}

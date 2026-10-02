package com.hivemind.phone.ui.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Device
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Person
import com.hivemind.phone.core.Phone
import com.hivemind.phone.live.OverviewFeed
import com.hivemind.phone.ui.common.CoreCalls
import com.hivemind.phone.ui.common.Notice
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** Whose the phone is, and each of their devices it paired with (design §6.7). */
data class DevicesState(val person: Person?, val devices: List<Device>) {
    companion object {
        fun of(overview: Overview) = DevicesState(overview.person, overview.devices)
    }
}

class DevicesViewModel(private val phone: Phone, feed: OverviewFeed) : ViewModel() {
    val state: StateFlow<DevicesState> = feed.overview.map(DevicesState::of)
        .stateIn(viewModelScope, SharingStarted.Eagerly, DevicesState.of(feed.overview.value))

    val calls = CoreCalls(viewModelScope)

    /** Unpairs from [device]: each forgets the other (spec/pairing.md, "Unpairing"). */
    fun unpair(device: Device) = calls.launch(device.id, { phone.unpair(device.id) }) { unpaired ->
        if (!unpaired) calls.tell(Notice.AlreadyUnpaired)
    }
}

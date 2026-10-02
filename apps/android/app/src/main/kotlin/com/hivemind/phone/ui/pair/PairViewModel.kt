package com.hivemind.phone.ui.pair

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hivemind.phone.core.Paired
import com.hivemind.phone.core.PairsWith
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.pairsWith
import kotlinx.coroutines.launch

sealed interface PairState {
    data object Ready : PairState

    /** Pairing, with the device the link names (none for one that names none: the core says why). */
    data class Pairing(val with: PairsWith?) : PairState

    /** Paired: with which device, and whose the phone is now. */
    data class Done(val paired: Paired) : PairState

    /** Why not, in the core's words: not a link, the code expired, the computer not answering. */
    data class Failed(val message: String) : PairState
}

/** Pairing with one of the person's computers, from the link its QR code holds (design §6.1). */
class PairViewModel(private val phone: Phone) : ViewModel() {
    var state: PairState by mutableStateOf(PairState.Ready)
        private set

    private var scanned: String? = null

    /** Pairs with the link, as pasted: tried each time it is asked. */
    fun pair(link: String) {
        if (state is PairState.Pairing) return
        val text = link.trim()
        state = PairState.Pairing(pairsWith(text))
        viewModelScope.launch {
            state = try {
                PairState.Done(phone.pair(text))
            } catch (e: PhoneException) {
                PairState.Failed(e.message.orEmpty())
            }
        }
    }

    /**
     * A code the camera read. It reads the same one many times a second, each tried once; and a
     * code that is no pairing link (a menu, a parcel) is none of its business.
     */
    fun scanned(text: String) {
        if (text == scanned || pairsWith(text) == null) return
        scanned = text
        pair(text)
    }
}

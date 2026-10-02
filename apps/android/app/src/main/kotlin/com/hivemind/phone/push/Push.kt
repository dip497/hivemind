package com.hivemind.phone.push

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.edit
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.hivemind.phone.R
import com.hivemind.phone.core.Overview
import com.hivemind.phone.core.Phone
import com.hivemind.phone.core.PhoneException
import com.hivemind.phone.core.PushAt
import com.hivemind.phone.core.PushTold
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.ResolvedDistributor

/** How the phone is told while the app is away, as Devices says it (P6). */
sealed interface PushState {
    /** Paired with nothing: there is no device to tell it. */
    data object Unpaired : PushState

    /** No UnifiedPush distributor on this phone. */
    data object NoDistributor : PushState

    /** Several, none chosen yet: the system asks the person which. */
    data object ToChoose : PushState

    /** The distributor, by its name, asked for where the phone is told. */
    data class Registering(val distributor: String) : PushState

    data class RegistrationFailed(val reason: FailedReason) : PushState

    /** The distributor tells the phone no more. */
    data object Dropped : PushState

    /** Where the phone is told was given to the person's devices: through which push server, who took it, who was away. */
    data class Told(val told: PushTold) : PushState

    /** It could not be given, in the core's words. */
    data class NotTold(val why: String) : PushState
}

/**
 * Where the person's devices tell the phone while the app is away (P6, spec/push.md): an endpoint
 * from the UnifiedPush distributor the person has (ntfy, say; no Google services), given to each
 * device by the core as it comes, as the devices change, and each time the app comes to the
 * foreground, when a device that was away takes it. The registration's one owner.
 */
class Push(
    private val context: Context,
    private val phone: Phone,
    overview: StateFlow<Overview>,
    private val scope: CoroutineScope,
) : DefaultLifecycleObserver {
    private val kept = context.getSharedPreferences("push", Context.MODE_PRIVATE)

    private val now = MutableStateFlow<PushState>(PushState.Unpaired)
    val state: StateFlow<PushState> = now.asStateFlow()

    // One telling at a time: asked again meanwhile, it tells once more after, with the newest endpoint.
    private val asks = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch { for (ask in asks) told() }
        scope.launch {
            var started = false
            overview.map { it.devices.map { device -> device.id }.toSet() }.distinctUntilChanged().collect { devices ->
                when {
                    devices.isEmpty() -> now.value = PushState.Unpaired
                    // As the app starts, and once paired: the distributor asked again, as UnifiedPush
                    // would have it, and it answers with where. A device paired or unpaired since: told.
                    !started || kept.getString(ENDPOINT, null) == null -> register()
                    else -> tell()
                }
                started = true
            }
        }
    }

    /** Registers with the distributor the person has: the one used before, else the system's default. */
    fun register() {
        val distributor = UnifiedPush.getAckDistributor(context) ?: when (val found = UnifiedPush.resolveDefaultDistributor(context)) {
            is ResolvedDistributor.Found -> found.packageName.also { UnifiedPush.saveDistributor(context, it) }
            ResolvedDistributor.ToSelect -> return run { now.value = PushState.ToChoose }
            ResolvedDistributor.NoneAvailable -> return run { now.value = PushState.NoDistributor }
        }
        if (kept.getString(ENDPOINT, null) == null) now.value = PushState.Registering(label(distributor))
        UnifiedPush.register(context, messageForDistributor = context.getString(R.string.app_name))
    }

    /** Tried again, from Devices: the devices told again when they were not, else the distributor asked again. */
    fun again() = if (now.value is PushState.NotTold) tell() else register()

    /** The person picks one of several distributors, in the system's chooser, from [activity]. */
    fun choose(activity: Activity) = UnifiedPush.tryUseDefaultDistributor(activity) { chosen -> if (chosen) register() }

    /** Where the distributor tells the phone now: given to every device. */
    fun newEndpoint(endpoint: String) {
        kept.edit { putString(ENDPOINT, endpoint) }
        tell()
    }

    fun registrationFailed(reason: FailedReason) {
        now.value = PushState.RegistrationFailed(reason)
    }

    fun unregistered() {
        kept.edit { remove(ENDPOINT) }
        now.value = PushState.Dropped
    }

    /** Gives every device where the phone is told; nothing until the distributor has said where. */
    fun tell() {
        asks.trySend(Unit)
    }

    override fun onStart(owner: LifecycleOwner) = tell()

    private suspend fun told() {
        val endpoint = kept.getString(ENDPOINT, null) ?: return
        now.value = try {
            PushState.Told(phone.pushTo(PushAt.UnifiedPush(endpoint)))
        } catch (e: PhoneException) {
            PushState.NotTold(e.message.orEmpty())
        }
    }

    private fun label(distributor: String): String = try {
        val packages = context.packageManager
        packages.getApplicationLabel(packages.getApplicationInfo(distributor, 0)).toString()
    } catch (e: PackageManager.NameNotFoundException) {
        distributor
    }

    private companion object {
        const val ENDPOINT = "endpoint"
    }
}

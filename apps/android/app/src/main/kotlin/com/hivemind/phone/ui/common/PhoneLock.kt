package com.hivemind.phone.ui.common

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * The phone's own lock (its fingerprint, face or PIN), asked before starting or closing an agent:
 * driving an agent runs code on the person's computer (design §4).
 *
 * Made in the activity's onCreate, as BiometricPrompt needs to be.
 */
class PhoneLock(private val activity: FragmentActivity) {
    private var unlocked: (() -> Unit)? = null

    private val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                unlocked?.invoke()
                unlocked = null
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                unlocked = null
            }
        },
    )

    /**
     * Asks the lock, and calls [then] once it opens; false, asking nothing, when the phone has no
     * lock set.
     */
    fun ask(title: String, subtitle: String, then: () -> Unit): Boolean {
        if (BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS) != BiometricManager.BIOMETRIC_SUCCESS) return false
        unlocked = then
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build(),
        )
        return true
    }

    private companion object {
        // Weak biometrics or the PIN, pattern or password: Android 10 takes no other pairing with
        // the device credential.
        const val AUTHENTICATORS = BIOMETRIC_WEAK or DEVICE_CREDENTIAL
    }
}

val LocalPhoneLock = staticCompositionLocalOf<PhoneLock> { error("no PhoneLock: MainActivity provides it") }

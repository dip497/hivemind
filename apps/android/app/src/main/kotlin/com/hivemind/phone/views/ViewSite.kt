package com.hivemind.phone.views

import android.net.Uri

/**
 * Where a community view's files are served to the web view that shows it (design §6.1): an https
 * origin of the view's own, `https://<label>.views.hivemind.invalid`. `.invalid` never resolves
 * (RFC 2606), so whatever the page asks for is answered by the app or not at all. The label is the
 * view's id as the view SDK makes a hostname of it (`viewHost`): `@scope/name` written
 * `scope--name`, a bare id as it is; ids are refused `--` of their own, so one view's origin is
 * never another's.
 */
class ViewSite private constructor(val label: String) {
    val host: String = "$label.$DOMAIN"

    /** The view's origin, as the web view names it: no path, no port. */
    val origin: String = "https://$host"

    /** The address of the view's file at [path], relative to its folder. */
    fun url(path: String): String = "$origin/$path"

    /** Whether a message the page posted came from the view itself: its own origin's main frame. */
    fun isTheView(origin: Uri, mainFrame: Boolean): Boolean =
        mainFrame && origin.scheme == "https" && origin.host == host && origin.port == -1

    companion object {
        private const val DOMAIN = "views.hivemind.invalid"

        // The view SDK's own rule for an id (manifest.ts `isViewId`): a bare name, or `@owner/name`
        // from HiveHub; lowercase letters, digits and single dashes.
        private val ID = Regex("^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}/)?[a-z0-9][a-z0-9-]{1,63}$")

        /** The site of the view [id]; null for what is not a view's id, or makes no hostname's label. */
        fun of(id: String): ViewSite? {
            if (!ID.matches(id)) return null
            val label = if (id.startsWith("@")) id.substring(1).replaceFirst("/", "--") else id
            return if (label.length <= 63) ViewSite(label) else null
        }
    }
}

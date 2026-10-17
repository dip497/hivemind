// AGP compiles Kotlin itself (built-in Kotlin); this classpath entry only lifts the Kotlin it uses
// from AGP's own floor to the catalog's, the version the Compose compiler plugin is built for.
buildscript {
    dependencies {
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}

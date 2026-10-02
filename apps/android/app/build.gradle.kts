import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// What scripts/phone/build-android.sh writes: the core's libraries for each ABI (jniLibs) and its
// Kotlin bindings (kotlin). Kept outside build/, so `-PskipCore` finds the last ones after a clean.
val core: Directory = layout.projectDirectory.dir("generated")

android {
    namespace = "com.hivemind.phone"
    compileSdk = 37
    ndkVersion = libs.versions.ndk.get()

    defaultConfig {
        applicationId = "com.hivemind.phone"
        minSdk = 29
        // 36, not 37: from 37 Android 17 drops every packet to the local network (pairing, mDNS,
        // a computer on the same Wi-Fi) until the person grants ACCESS_LOCAL_NETWORK at runtime.
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { compose = true }

    sourceSets {
        getByName("main") {
            kotlin.directories.add(core.dir("kotlin").asFile.path)
            jniLibs.directories.add(core.dir("jniLibs").asFile.path)
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

kotlin {
    compilerOptions { jvmTarget = JvmTarget.JVM_17 }
}

composeCompiler {
    stabilityConfigurationFiles.add(layout.projectDirectory.file("compose-stability.conf"))
}

// The phone's Rust core for the app's two ABIs, and its Kotlin bindings. Cargo decides what is
// stale, so the task always runs; `-PskipCore` reuses what the last run wrote, and
// `-PcoreAbis=x86_64` builds fewer ABIs, for a quicker build on one's own machine.
val buildCore = tasks.register<Exec>("buildCore") {
    description = "Builds crates/hive-phone-ffi for arm64-v8a and x86_64 and generates its Kotlin bindings."
    group = "build"
    val skip = providers.gradleProperty("skipCore").isPresent
    val abis = providers.gradleProperty("coreAbis").orNull
    // The NDK AGP resolved for `ndkVersion`, so cargo-ndk links with the one the app is built with.
    val ndk = androidComponents.sdkComponents.ndkDirectory
    workingDir(rootProject.layout.projectDirectory.dir("../.."))
    commandLine("bash", "scripts/phone/build-android.sh", core.asFile.path)
    onlyIf("not -PskipCore") { !skip }
    doFirst {
        environment("ANDROID_NDK_HOME", ndk.get().asFile.path)
        if (abis != null) environment("PHONE_ABIS", abis.replace(',', ' '))
    }
}
tasks.named("preBuild") { dependsOn(buildCore) }

tasks.withType<Test>().configureEach {
    // Robolectric's Android 16 reaches into the JDK's file descriptors, and its SystemCleaner (which
    // the bindings use from API 34) into the JDK's cleaner.
    jvmArgs(
        "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED",
        "--add-opens=java.base/java.io=ALL-UNNAMED",
        "--add-exports=java.base/jdk.internal.ref=ALL-UNNAMED",
    )
    // The core built for this machine (scripts/phone/build-android.sh), which JNA loads in the
    // tests that run it, as it loads the app's own on a phone.
    systemProperty("jna.library.path", core.dir("host").asFile.path)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.navigation3)
    implementation(libs.androidx.navigation3.runtime)
    implementation(libs.androidx.navigation3.ui)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.core)
    implementation(libs.zxing.core)
    // Told while the app is away (P6): UnifiedPush, through the distributor the person has (no
    // Google services); an answer from a notification, by WorkManager, the app left closed.
    implementation(libs.unifiedpush.connector)
    implementation(libs.androidx.work.runtime)
    // Community views (P8): each in a web view, its files served by the app, joined to the core.
    implementation(libs.androidx.webkit)
    // The generated bindings call the core through JNA; its AAR carries the Android dispatch libraries.
    implementation(variantOf(libs.jna) { artifactType("aar") })
    // Debug builds count their frames (FrameMeter, design §3.8).
    debugImplementation(libs.androidx.metrics.performance)

    // JNA as a jar: its dispatch library for this machine, which the AAR has not.
    testImplementation(libs.jna)
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}

package com.hivemind.phone.ui.pair

import android.util.Size
import androidx.camera.core.CameraInfoUnavailableException
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors

/**
 * A camera, reading QR codes: the back one, else the front one (a Chromebook's, some tablets'); each
 * code's text goes to [onCode], on the main thread. A camera that cannot be opened, CameraX finding
 * none or failing to start, is told to [onUnavailable] instead. CameraX and ZXing alone, no Play
 * services.
 */
@Composable
fun QrScanner(onCode: (String) -> Unit, onUnavailable: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val latest by rememberUpdatedState(onCode)
    val unavailable by rememberUpdatedState(onUnavailable)
    val reading = remember { Executors.newSingleThreadExecutor() }
    val preview = remember { PreviewView(context) }

    DisposableEffect(owner) {
        val main = ContextCompat.getMainExecutor(context)
        val providing = ProcessCameraProvider.getInstance(context)
        var gone = false
        // The provider got, once it is: the only one to unbind as the screen goes.
        var got: ProcessCameraProvider? = null
        providing.addListener({
            // The screen left before the camera was ready: CameraX refuses a lifecycle that ended.
            if (gone) return@addListener
            try {
                val provider = providing.get().also { got = it }
                val camera = listOf(CameraSelector.DEFAULT_BACK_CAMERA, CameraSelector.DEFAULT_FRONT_CAMERA)
                    .firstOrNull(provider::hasCamera)
                if (camera == null) {
                    unavailable()
                    return@addListener
                }
                val shown = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                            .build(),
                    )
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(reading, QrReader { text -> main.execute { latest(text) } })
                provider.unbindAll()
                provider.bindToLifecycle(owner, camera, shown, analysis)
            } catch (e: Exception) {
                // CameraX could not start (no camera, a camera service gone), or found no camera to
                // bind: the link can still be pasted.
                when (e) {
                    is ExecutionException, is IllegalArgumentException, is IllegalStateException, is CameraInfoUnavailableException ->
                        unavailable()
                    else -> throw e
                }
            }
        }, main)
        onDispose {
            gone = true
            got?.unbindAll()
            reading.shutdown()
        }
    }
    AndroidView(factory = { preview }, modifier = modifier)
}

/** Finds a QR code in each camera frame's brightness, and hands on its text. */
private class QrReader(private val onText: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = QRCodeReader()
    private var luminance = ByteArray(0)

    override fun analyze(image: ImageProxy) {
        image.use {
            val plane = it.planes[0]
            val width = it.width
            val height = it.height
            if (luminance.size != width * height) luminance = ByteArray(width * height)
            val pixels = plane.buffer
            // Rows may be padded past the image's width: copy the image's own bytes, row by row.
            for (row in 0 until height) {
                pixels.position(row * plane.rowStride)
                pixels.get(luminance, row * width, width)
            }
            val source = PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false)
            try {
                onText(reader.decode(BinaryBitmap(HybridBinarizer(source))).text)
            } catch (_: ReaderException) {
                // No code in this frame.
            } finally {
                reader.reset()
            }
        }
    }
}

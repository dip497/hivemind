import AVFoundation
import SwiftUI
import UIKit

/// The camera, reading one QR code with AVFoundation's metadata output: its text goes to `found`,
/// once.
struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        QRScannerController(found: found)
    }

    func updateUIViewController(_ controller: QRScannerController, context: Context) {}
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let found: (String) -> Void
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.hivemind.phone.camera")
    private var preview: AVCaptureVideoPreviewLayer?
    private let note = UILabel()
    private var reported = false

    init(found: @escaping (String) -> Void) {
        self.found = found
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        note.textColor = .white
        note.textAlignment = .center
        note.numberOfLines = 0
        note.font = .preferredFont(forTextStyle: .callout)
        view.addSubview(note)

        // A phone without a camera (the simulator) is not asked for the camera at all.
        guard let camera = AVCaptureDevice.default(for: .video) else {
            say("No camera here. Paste the link instead.")
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            start(camera)
        case .notDetermined:
            Task { [weak self] in
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                guard let self else { return }
                if granted {
                    self.start(camera)
                } else {
                    self.say("Hivemind may not use the camera. Paste the link instead.")
                }
            }
        default:
            say("Hivemind may not use the camera: allow it in Settings, or paste the link.")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        note.frame = view.bounds.insetBy(dx: 24, dy: 24)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let camera = self.session
        sessionQueue.async { camera.stopRunning() }
    }

    private func start(_ camera: AVCaptureDevice) {
        guard let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else {
            say("The camera could not be opened. Paste the link instead.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            say("The camera could not read codes. Paste the link instead.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        // startRunning blocks until the camera runs: off the main thread.
        let running = self.session
        sessionQueue.async { running.startRunning() }
    }

    private func say(_ text: String) {
        note.text = text
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        // Delivered on the main queue (`setMetadataObjectsDelegate` above).
        let code = metadataObjects
            .compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
            .first
        guard let code else { return }
        MainActor.assumeIsolated {
            guard !reported else { return }
            reported = true
            found(code)
        }
    }
}

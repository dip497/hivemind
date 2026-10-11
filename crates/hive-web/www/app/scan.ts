// Scanning a pairing link's QR code (the Android app's camera on PairScreen): the rear camera's
// frames, each read by the wasm (hive-web's `readQr`), as Safari has no BarcodeDetector.

import { h } from "./dom.js";

/** How often a frame is read, and how wide at most: enough for a code that fills the view. */
const EVERY = 150;
const WIDEST = 640;

export class Scanner {
  readonly el = h("video", { class: "scan", playsinline: true, muted: true, hidden: true, "data-scan-video": "" });
  private stream: MediaStream | null = null;
  private timer = 0;

  /** Read frames with `read` until one shows a code: `found` is given its text, and the camera
   *  stops. Throws when the camera cannot be opened. */
  async start(read: (rgba: Uint8Array, width: number, height: number) => string | null, found: (text: string) => void): Promise<void> {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    this.stream = stream;
    this.el.srcObject = stream;
    this.el.hidden = false;
    await this.el.play();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const tick = () => {
      if (this.stream !== stream) return;
      const { videoWidth: w, videoHeight: h } = this.el;
      if (w > 0) {
        const scale = Math.min(1, WIDEST / w);
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        ctx.drawImage(this.el, 0, 0, canvas.width, canvas.height);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const text = read(new Uint8Array(data.buffer), canvas.width, canvas.height);
        if (text) {
          this.stop();
          return found(text);
        }
      }
      this.timer = setTimeout(tick, EVERY);
    };
    tick();
  }

  get running(): boolean {
    return this.stream !== null;
  }

  stop(): void {
    clearTimeout(this.timer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.el.srcObject = null;
    this.el.hidden = true;
  }
}

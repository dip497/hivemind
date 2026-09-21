// Wallpapers live beside settings.json, which names them. A dev run keeps its own profile
// (userData) but shares settings with the app, so media kept in userData went missing on
// the other side — a broken photo that showed the moment anything re-applied the theme.
import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// A real, decodable JPEG (1×1), so "loaded" means the file was found and served.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");

test("a photo named in the shared settings loads in a run with its own profile", async () => {
  test.setTimeout(60_000);
  const dir = fs.mkdtempSync("/tmp/hm-mbs-");
  const config = path.join(dir, "xdg/hivemind");
  fs.mkdirSync(path.join(config, "media"), { recursive: true });
  fs.mkdirSync(path.join(dir, "home"));
  fs.writeFileSync(path.join(config, "media/bg.jpg"), JPEG);
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({
    v: 1, migrated: true,
    appearance: { wallpaper: { kind: "image", imageSrc: "hivemedia://media/bg.jpg", brightness: 0.9 }, glass: { enabled: true } },
  }));
  const app = await electron.launch({
    // A profile that is NOT the settings folder — what a dev run is.
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/other-profile`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => {
      const img = document.querySelector(".hm-wp-image") as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    }), { timeout: 10_000 }).toBe(true);
  } finally {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

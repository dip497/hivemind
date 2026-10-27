// A terminal gives text the columns programs measure it by: an emoji two, a Devanagari syllable
// one. Counted any other way, an agent's table or prompt lands in other columns and leaves pieces of
// itself on the screen.
import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { stopDaemons } from "./helpers/daemons";

const WORDS = ["abc", "👍", "⚠️", "👨‍👩‍👧", "日本語", "हेमशैलाभदेहं", "वानराणामधीशं"];

test("the cursor stands after each text where a program measuring it expects", async () => {
  const root = fs.mkdtempSync("/tmp/hm-widths-");
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HOME: path.join(root, "home"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HIVE_SETTINGS;
  fs.mkdirSync(env.HOME);
  // Each text, then where the terminal says its cursor is (CSI 6n).
  const script = path.join(root, "widths.sh");
  fs.writeFileSync(script, `out=WIDTHS
for w in ${WORDS.map((w) => `'${w}'`).join(" ")}; do
  printf '\\r\\033[2K%s\\033[6n' "$w"; IFS=';' read -rsd R _ col; out="$out $((col - 1))"
done
printf '\\r\\033[2K%s\\n' "$out"
`);
  const app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await page.waitForSelector(".xterm-helper-textarea");
    await page.waitForTimeout(1500);
    await page.locator(".xterm-helper-textarea").first().focus();
    await page.keyboard.type(`bash ${script}\n`);
    const screen = () => page.evaluate(() => [...document.querySelectorAll(".react-flow__node-terminal *")]
      .map((x) => (x as HTMLElement & { __hmScreen?: () => string }).__hmScreen?.() ?? "").join("\n"));
    await expect.poll(async () => /^WIDTHS[ \d]+$/m.exec(await screen())?.[0], { timeout: 15_000 }).toBe("WIDTHS 3 2 2 2 6 7 7");
  } finally {
    await app.close();
    stopDaemons(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

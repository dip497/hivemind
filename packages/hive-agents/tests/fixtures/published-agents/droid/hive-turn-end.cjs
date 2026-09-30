// Droid's Stop: read the reply from Droid's own transcript, hand it to the host, report the turn end.
const fs = require("fs");
let hive;
try { hive = require(process.env.HIVE_SDK); } catch (e) { process.exit(0); }

const TAIL_BYTES = 256 * 1024;
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
// The last assistant entry with text, scanning back from the end. Entries are one JSON per line:
// `{role, content}` flat, or nested under `message`.
function lastReply(raw) {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch (x) { continue; }
    const assistant = e.type === "assistant" || e.role === "assistant" || (e.message && e.message.role === "assistant");
    if (!assistant) continue;
    const text = textOf(e.message ? e.message.content : e.content).trim();
    if (text) return text;
  }
  return null;
}
function readReply(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > TAIL_BYTES) {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(TAIL_BYTES);
      const n = fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      fs.closeSync(fd);
      const tail = buf.toString("utf8", 0, n);
      const found = lastReply(tail.slice(tail.indexOf("\n") + 1));
      if (found) return found;
    }
    return lastReply(fs.readFileSync(file, "utf8"));
  } catch (e) { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const p = await hive.payload();
  if (typeof p.transcript_path === "string") {
    // The last message can land in the file a beat after Stop fires.
    let reply = readReply(p.transcript_path);
    for (let i = 0; !reply && i < 4; i++) { await sleep(130); reply = readReply(p.transcript_path); }
    if (reply) await hive.reportReply(reply);
  }
  await hive.emit("turn.ended");
})().catch(() => {}).finally(() => process.exit(0));

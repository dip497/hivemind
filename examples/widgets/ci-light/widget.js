// The build's status as a light: green, red, or amber while it runs. Your CI wrapper, a git hook or
// an agent sets it (`hive ctl plugin call @dip497/ci-light set '{"state":"failed"}'`, or
// `hive ctl view emit ci.build '{"state":"failed"}'`); when it is red, one press asks an agent to
// fix it, with a prompt you read before it is sent.
const STATES = ["passed", "failed", "running", "unknown"];
const SAYS = { passed: "Build passed", failed: "Build failed", running: "Build running", unknown: "No build yet" };
const st = () => ({ state: "unknown", ...(hive.state || {}) });

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

function draw() {
  const s = st();
  const caps = hive.hm.capabilities;
  // Until the app sends the client's values, hive.hm answers every name with a call.
  const can = Array.isArray(caps) && caps.includes("workspace:spawn");
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "image", src: `light-${s.state}.svg`, w: 44, h: 44, label: SAYS[s.state] },
        { type: "stack", children: [
          { type: "text", text: SAYS[s.state], size: "large" },
          { type: "text", text: [s.name, s.branch, s.at ? ago(s.at) : null].filter(Boolean).join(" · ") || "Waiting for a report", muted: true },
        ] },
      ] },
      ...(s.detail ? [{ type: "text", text: s.detail, wrap: true }] : []),
      ...(s.state === "failed" && can ? [{ type: "button", label: "Ask an agent to fix it", action: "fix" }] : []),
    ],
  });
}

function set(a) {
  if (!a || !STATES.includes(a.state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
  const text = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
  const next = { state: a.state, name: text(a.name, 60), branch: text(a.branch, 60), detail: text(a.detail, 200), at: Date.now() };
  const was = st().state;
  hive.setState(next);
  if (was !== "failed" && next.state === "failed") hive.notify(`${next.name ?? "The build"} failed${next.branch ? ` on ${next.branch}` : ""}`);
  draw();
  return next;
}

hive.on("start", () => {
  draw();
  hive.hm.onCustom("ci.*", (e) => { try { set(e.data); } catch { /* not a report this light reads */ } });
  setInterval(draw, 30_000);
});
hive.on("action", (a) => {
  if (a !== "fix") return;
  const s = st();
  hive.hm.commands.spawnAgent(null, null, {
    name: "Fix the build",
    prompt: `The build${s.name ? ` "${s.name}"` : ""}${s.branch ? ` on ${s.branch}` : ""} failed${s.detail ? `: ${s.detail}` : ""}. Find out why, fix it, and run it again.`,
  });
});

hive.hm.onCommand("set", set);
hive.hm.onCommand("status", () => st());

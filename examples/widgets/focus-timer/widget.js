// A focus timer: work for a set time, then a break, round after round. What it keeps (the phase,
// when it ends) is the widget's state, so it is the same for everyone and survives a restart; an
// agent can start one for you, or ask how long is left, through its commands.
const minutes = (phase) => Number(phase === "break" ? hive.options.break ?? 5 : hive.options.focus ?? 25);
const now = () => Date.now();
const st = () => ({ phase: "focus", endsAt: null, left: null, rounds: 0, ...(hive.state || {}) });

function leftOf(s) {
  if (s.endsAt) return Math.max(0, s.endsAt - now());
  return s.left ?? minutes(s.phase) * 60_000;
}

const clock = (ms) => {
  const t = Math.ceil(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function draw() {
  const s = st();
  const left = leftOf(s);
  const total = minutes(s.phase) * 60_000;
  const running = !!s.endsAt;
  hive.render({
    type: "stack",
    children: [
      { type: "row", children: [
        { type: "number", value: clock(left), label: s.phase === "break" ? "break" : "focus" },
        { type: "text", text: `round ${s.rounds + 1}`, muted: true },
      ] },
      { type: "meter", value: total - left, max: total },
      { type: "row", children: [
        running ? { type: "button", label: "Pause", action: "pause" } : { type: "button", label: left < total ? "Resume" : "Start", action: "start" },
        { type: "button", label: "Reset", action: "reset" },
        { type: "button", label: s.phase === "break" ? "Skip break" : "Take a break", action: "switch" },
      ] },
    ],
  });
}

function start(m) {
  const s = st();
  const left = Number.isFinite(m) && m > 0 ? Math.min(m, 180) * 60_000 : leftOf(s);
  hive.setState({ ...s, endsAt: now() + left, left: null });
  draw();
  return status();
}
function pause() { const s = st(); hive.setState({ ...s, left: leftOf(s), endsAt: null }); draw(); return status(); }
function switchPhase(finished) {
  const s = st();
  const phase = s.phase === "focus" ? "break" : "focus";
  const rounds = s.phase === "focus" && finished ? s.rounds + 1 : s.rounds;
  hive.setState({ phase, rounds, endsAt: finished ? now() + minutes(phase) * 60_000 : null, left: null });
  draw();
}
function status() {
  const s = st();
  return { phase: s.phase, running: !!s.endsAt, left: clock(leftOf(s)), rounds: s.rounds };
}

hive.on("start", () => {
  draw();
  setInterval(() => {
    const s = st();
    if (!s.endsAt) return;
    if (s.endsAt <= now()) {
      hive.notify(s.phase === "focus" ? "Time for a break." : "Break is over: back to it.");
      switchPhase(true);
    } else draw();
  }, 1000);
});
hive.on("options", draw);
hive.on("action", (a) => {
  if (a === "start") start();
  else if (a === "pause") pause();
  else if (a === "reset") { hive.setState({ phase: "focus", endsAt: null, left: null, rounds: st().rounds }); draw(); }
  else if (a === "switch") switchPhase(false);
});

hive.hm.onCommand("start", (a) => start(a && Number(a.minutes)));
hive.hm.onCommand("pause", () => pause());
hive.hm.onCommand("status", () => status());

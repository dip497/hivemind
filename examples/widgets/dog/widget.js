// A dog that lives along the bottom of the screen and keeps an eye on your agents. It barks when one
// starts waiting on you and sits by the right edge until you answer, jumps when a turn finishes,
// and naps once every agent has been idle a while. Click it to go to the agent that waits.
// It reads the agents through hive.hm and asks for no permission.
const SHEET = { walk: [0, 10], sit: [1, 6], sleep: [2, 3], bark: [3, 8], jump: [4, 10] }; // row, frames per second
const SCREEN_AT_A_WALK = 14000; // ms to cross the whole screen: it never goes faster than this
const NAP_AFTER = 90_000;
const BY_THE_EDGE = 0.94;

const states = new Map(); // tile id -> working | waiting | idle | stuck | exited
const watching = new Map();
const names = new Map();
const waitingSince = new Map(); // in the order they started waiting
let pose = "sit";
let facing = 1;
let next = null;
let napClock = null;

const name = () => String(hive.options.name || "Biscuit");
const busy = () => [...states.values()].some((s) => s === "working" || s === "waiting");

function draw() {
  const [row, fps] = SHEET[pose];
  hive.render({ type: "sprite", src: "dog.png", frameW: 32, frameH: 32, row, frames: 6, fps, scale: 3, flip: facing < 0, label: `${name()} is ${doing()}` });
}

function doing() {
  if (pose === "sleep") return "asleep";
  if (pose === "bark") return "barking";
  if (pose === "jump") return "jumping";
  if (pose === "walk") return "walking";
  return waitingSince.size ? "waiting with you" : "sitting";
}

const later = (ms, f) => { clearTimeout(next); next = setTimeout(f, ms); };
const be = (p) => { pose = p; draw(); };

function walkTo(x, then) {
  const from = hive.spot.x;
  if (Math.abs(x - from) < 0.01) return then();
  facing = x >= from ? 1 : -1;
  const over = Math.max(700, Math.abs(x - from) * SCREEN_AT_A_WALK);
  be("walk");
  hive.moveTo({ x, y: "bottom" }, { over });
  later(over, then);
}

/** What it does when nothing calls it: keep someone who waits company, nap, or potter about. */
function carryOn() {
  if (waitingSince.size) return walkTo(BY_THE_EDGE, () => { be("sit"); later(4000, carryOn); });
  if (pose === "sleep") return;
  const from = hive.spot.x;
  const to = Math.min(0.9, Math.max(0.05, from + (Math.random() - 0.5) * 0.5));
  walkTo(to, () => { be("sit"); later(2500 + Math.random() * 5000, carryOn); });
}

function restartNapClock() {
  clearTimeout(napClock);
  napClock = setTimeout(() => (busy() ? restartNapClock() : nap()), NAP_AFTER);
}

function nap() {
  if (pose === "walk") { napClock = setTimeout(nap, 1000); return; }
  clearTimeout(next);
  be("sleep");
}

function wake() {
  restartNapClock();
  if (pose === "sleep") be("sit");
}

function bark(id) {
  wake();
  if (!hive.options.quiet) hive.notify(`${name()} barks: ${names.get(id) || "an agent"} is waiting on you`);
  be("bark");
  later(2400, carryOn);
}

function stateOf(status, info) {
  const s = info && info.agent && info.agent.state;
  if (s === "waiting" || status === "blocked") return "waiting";
  if (s === "working" || status === "working") return "working";
  if (s === "failed" || s === "limited") return "stuck";
  if (status === "exited" || s === "exited") return "exited";
  return "idle";
}

function heard(id, status, info) {
  const was = states.get(id);
  const now = stateOf(status, info);
  states.set(id, now);
  restartNapClock();
  if (now !== "waiting") waitingSince.delete(id);
  if (now === "waiting" && was !== "waiting") {
    waitingSince.set(id, true);
    return bark(id);
  }
  if (now === "working" && pose === "sleep") { be("sit"); later(1200, carryOn); }
  if (!waitingSince.size && pose === "sit" && was === "waiting") carryOn();
}

hive.on("start", () => {
  hive.moveTo({ x: 0.7, y: "bottom" }, { over: 0 });
  draw();
  restartNapClock();
  later(1500, carryOn);
  hive.hm.on("structure", ({ tiles }) => {
    const agents = new Set(tiles.filter((t) => t.agent).map((t) => t.id));
    for (const t of tiles) names.set(t.id, t.name);
    for (const [id, stop] of watching) if (!agents.has(id)) { stop(); watching.delete(id); states.delete(id); waitingSince.delete(id); }
    for (const id of agents) if (!watching.has(id)) watching.set(id, hive.hm.subscribeStatus(id, (s, info) => heard(id, s, info)));
  });
  hive.hm.onEvents(["turn"], () => {
    wake();
    if (pose === "bark") return;
    be("jump");
    later(1800, carryOn);
  });
});

hive.on("click", () => {
  wake();
  const first = waitingSince.keys().next().value;
  if (first) hive.hm.commands.focusTile(first);
  be("sit");
  later(first ? 4000 : 3000, carryOn);
});

hive.on("options", draw);

hive.hm.onCommand("status", () => ({
  name: name(),
  doing: doing(),
  waitingOn: [...waitingSince.keys()].map((id) => names.get(id) || id),
}));

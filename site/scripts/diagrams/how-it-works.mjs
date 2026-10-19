// The diagrams of "How it works": what runs where, and how the parts talk.
// Each fact here is traced to the code in reports/research_notes/docs-architecture/map.md.
import { Diagram, C } from './draw.mjs';

const dot = (d, x, y) => d.raw(`<circle cx="${x}" cy="${y}" r="6" fill="${C.ink}"/>`, false);

function architecture() {
  const d = new Diagram({
    slug: 'architecture', w: 1000, h: 612,
    title: 'What runs where',
    desc: 'On your computer the desktop app, the background process that runs your agents, and the hive command. Your own network server relays encrypted traffic to your phone and hosts. Machines are reached over ssh, plugins come from HiveHub.',
  });
  d.zone(20, 40, 590, 404, 'Your computer');
  d.zone(660, 180, 320, 116, 'Your server');
  d.zone(660, 460, 320, 132, 'Other machines');
  // Inside your computer.
  d.wire([[264, 118], [350, 118]]); d.label(307, 100, 'drive.sock');
  d.wire([[468, 156], [468, 240]], { start: true }); d.label(480, 198, 'pty socket', { anchor: 'start' });
  d.wire([[350, 266], [264, 266]]); d.label(307, 248, 'runs');
  d.wire([[264, 290], [350, 290]]); d.label(307, 308, 'hooks');
  d.wire([[154, 240], [154, 156]]); d.label(144, 198, 'hive ctl', { anchor: 'end' });
  // Out of your computer.
  d.wire([[586, 96], [680, 96]], { link: true }); d.label(633, 78, 'https');
  d.wire([[586, 118], [636, 118], [636, 238], [680, 238]], { accent: true }); d.label(646, 160, 'encrypted', { anchor: 'start' });
  d.wire([[586, 137], [622, 137], [622, 520], [680, 520]]); d.label(632, 400, 'ssh', { anchor: 'start' });
  d.wire([[770, 270], [770, 350]], { link: true }); d.label(780, 310, 'https', { anchor: 'start' });
  d.wire([[900, 270], [900, 488]], { start: true }); d.label(910, 440, 'relay', { anchor: 'start' });
  d.node(44, 80, 220, 76, 'hive command', { sub: 'you, agents, programs' });
  d.node(350, 80, 236, 76, 'Desktop app', { sub: 'windows · canvas · views', focal: true });
  d.node(44, 240, 220, 76, 'Your agents', { sub: 'each in a terminal' });
  d.node(350, 240, 236, 76, 'Background process', { sub: 'terminals · agent states' });
  d.note(44, 364, 'Stays on this computer: your keys, settings,', { anchor: 'start', size: 12 });
  d.note(44, 382, 'API tokens and saved screens.', { anchor: 'start', size: 12 });
  d.note(44, 412, 'Closing the window leaves agents running.', { anchor: 'start', size: 12 });
  d.node(680, 64, 280, 64, 'HiveHub', { sub: 'plugins to install', dashed: true, plain: true });
  d.node(680, 206, 280, 64, 'Network server', { sub: 'hive-net serve', mono: true });
  d.node(680, 350, 180, 64, 'Phone page', { sub: "your phone's browser" });
  d.node(680, 488, 130, 64, 'Machine', { sub: 'over ssh' });
  d.node(830, 488, 130, 64, 'Host', { sub: 'hive host', mono: true });
  return d;
}

function desktopProcesses() {
  const d = new Diagram({
    slug: 'desktop-processes', w: 860, h: 372,
    title: 'Inside the desktop app',
    desc: 'Each window draws the canvas and talks to the main process over IPC. The main process keeps settings and the workspace, listens on the drive socket and the browser tab, and starts the background process and hive-net.',
  });
  d.wire([[240, 80], [320, 80]], { start: true }); d.label(280, 62, 'IPC');
  d.wire([[640, 80], [560, 80]]); d.label(600, 62, 'drive.sock');
  d.wire([[240, 256], [280, 256], [280, 104], [320, 104]]); d.label(270, 180, 'WebSocket', { anchor: 'end' });
  d.wire([[440, 120], [440, 220]], { start: true }); d.label(450, 170, 'pty socket', { anchor: 'start' });
  d.wire([[520, 120], [520, 160], [740, 160], [740, 220]], { start: true }); d.label(630, 144, 'local socket');
  d.node(20, 40, 220, 80, 'Window', { sub: 'canvas · tiles · views' });
  d.node(320, 40, 240, 80, 'Main process', { sub: 'settings · workspace', focal: true });
  d.node(640, 40, 200, 80, 'hive ctl, programs', { sub: 'with a token' });
  d.node(20, 220, 220, 72, 'Browser tab', { sub: '127.0.0.1 only' });
  d.node(320, 220, 240, 72, 'Background process', { sub: 'terminals and agents' });
  d.node(640, 220, 200, 72, 'hive-net', { sub: 'this device on the network' });
  d.note(430, 344, 'Close every window: the background process keeps your terminals and agents running.', { size: 12 });
  return d;
}

function terminalBytes() {
  const d = new Diagram({
    slug: 'terminal-bytes', w: 900, h: 320,
    title: 'From an agent to its tile',
    desc: 'The agent program writes to its terminal in the background process, which keeps a copy of each screen and saves it to disk. The app gets the output and draws it in the tile; a tile that attaches again gets the screen replayed.',
  });
  d.wire([[190, 84], [260, 84]]); d.label(225, 66, 'output');
  d.wire([[260, 112], [190, 112]], { dashed: true }); d.label(225, 130, 'keys');
  d.wire([[480, 84], [560, 84]], { accent: true }); d.label(520, 66, 'live');
  d.wire([[560, 112], [480, 112]], { dashed: true }); d.label(520, 130, 'attach');
  d.wire([[710, 98], [770, 98]]);
  d.wire([[370, 136], [370, 212]]); d.label(380, 174, 'saved', { anchor: 'start' });
  d.node(20, 60, 170, 76, 'Agent program', { sub: 'claude, codex, …' });
  d.node(260, 60, 220, 76, 'Background process', { sub: 'a copy of each screen', focal: true });
  d.node(560, 60, 150, 76, 'Desktop app');
  d.node(770, 60, 110, 76, 'Tile');
  d.node(260, 212, 220, 64, 'Saved screens', { sub: 'sessions/<id>.json', mono: true });
  d.note(690, 230, 'On attach the screen is replayed,', { size: 12 });
  d.note(690, 248, 'then output goes on live.', { size: 12 });
  return d;
}

function driveSockets() {
  const d = new Diagram({
    slug: 'drive-sockets', w: 860, h: 352,
    title: 'Two local sockets',
    desc: 'hive ctl and your programs call the app or hive host on the drive socket with a token. Agent hooks send events to the control socket, which the background process owns and passes on to the app or the host.',
  });
  d.wire([[220, 72], [262, 72], [262, 104], [320, 104]]);
  d.wire([[220, 162], [282, 162], [282, 128], [320, 128]]);
  d.wire([[220, 272], [320, 272]]); d.label(270, 254, 'agent.event');
  d.wire([[500, 116], [600, 116]], { accent: true }); d.label(550, 98, 'token');
  d.wire([[500, 272], [600, 272]]);
  d.wire([[720, 236], [720, 152]]); d.label(730, 194, 'hcp-host.sock', { anchor: 'start' });
  d.node(20, 40, 200, 64, 'hive ctl', { sub: 'you or an agent' });
  d.node(20, 130, 200, 64, 'Your program', { sub: 'SDK and a token' });
  d.node(20, 240, 200, 64, 'Agent hook', { sub: 'turn started, asks…' });
  d.node(320, 80, 180, 72, 'Drive socket', { sub: 'drive.sock', mono: true });
  d.node(320, 236, 180, 72, 'Control socket', { sub: 'hcp.sock', mono: true });
  d.node(600, 80, 240, 72, 'The app or hive host', { sub: "checks the token's role", focal: true });
  d.node(600, 236, 240, 72, 'Background process', { sub: 'works out agent states' });
  d.note(430, 336, 'Only your user can open either one: a file with mode 0600, or a named pipe on Windows.', { size: 12 });
  return d;
}

function viewOpen() {
  const d = new Diagram({
    slug: 'view-open', w: 920, h: 520,
    title: 'An agent opens a view',
    desc: 'An agent runs hive ctl plugin open; the app asks the window to show the view; the window loads it in a sandboxed frame and hands it a message port; the view says ready, the window says hello with what the view may do, then sends it the workspace.',
  });
  const xs = [120, 350, 580, 810], top = 30, bh = 60, end = 470;
  xs.forEach((x) => d.lifeline(x, top + bh, end));
  const msg = (from, to, y, text, o = {}) => {
    const [a, b] = [xs[from], xs[to]], dir = Math.sign(b - a);
    d.wire([[a + dir * 4, y], [b - dir * 4, y]], o);
    d.label((a + b) / 2, y - 16, text);
  };
  msg(0, 1, 130, 'plugin.open view:<id>');
  msg(1, 2, 174, 'hcp:command');
  msg(2, 3, 218, 'load hm-view://<id>');
  msg(2, 3, 262, 'message port');
  msg(3, 2, 306, 'ready', { dashed: true });
  msg(2, 3, 350, 'hello', { accent: true });
  msg(2, 3, 394, 'structure, status');
  msg(3, 2, 438, 'command', { dashed: true });
  msg(1, 0, 218, 'answer', { dashed: true });
  d.note(695, 462, 'checked against its permissions', { size: 11.5 });
  d.node(30, top, 180, bh, 'Agent', { sub: 'hive ctl', mono: true });
  d.node(260, top, 180, bh, 'Main process', { sub: 'drive.sock', mono: true });
  d.node(490, top, 180, bh, 'Window', { sub: 'the renderer' });
  d.node(720, top, 180, bh, 'View', { sub: 'sandboxed frame', focal: true });
  d.note(460, 504, 'The view has no files, no network and no Node. All it knows comes over its port.', { size: 12 });
  return d;
}

function phoneFlow() {
  const d = new Diagram({
    slug: 'phone-flow', w: 900, h: 420,
    title: 'How your phone sees an agent',
    desc: "An agent's hook tells the background process, which works out its state. The app sends the state of every agent to your phone over hive-net, through the relay on your server, encrypted end to end. When the page is closed, a push notice goes through the same server.",
  });
  d.zone(20, 30, 860, 140, 'Your computer');
  d.zone(320, 228, 260, 128, 'Your server');
  d.wire([[194, 96], [300, 96]]); d.label(247, 78, 'hook');
  d.wire([[500, 96], [620, 96]]); d.label(560, 78, 'state');
  d.wire([[738, 134], [738, 286], [560, 286]], { accent: true }); d.label(748, 210, 'agents · needs', { anchor: 'start' });
  d.wire([[340, 276], [244, 276]], { accent: true }); d.label(292, 258, 'relay');
  d.wire([[340, 300], [244, 300]], { dashed: true }); d.label(292, 318, 'push');
  d.node(44, 60, 150, 72, 'Agent', { sub: 'asks something' });
  d.node(300, 60, 200, 72, 'Background process', { sub: 'its state' });
  d.node(620, 60, 236, 72, 'Desktop app', { sub: 'or hive host' });
  d.node(340, 252, 220, 72, 'Network server', { sub: 'hive-net serve', mono: true });
  d.node(44, 252, 200, 72, 'Phone page', { sub: "your phone's browser", focal: true });
  d.note(450, 398, 'Encrypted end to end: the server passes it on but cannot read it.', { size: 12 });
  return d;
}

function devicesNet() {
  const d = new Diagram({
    slug: 'devices-net', w: 860, h: 360,
    title: 'Two devices, one key each',
    desc: 'Two devices talk directly when they can, and through the relay of your own server when they cannot. Your server also looks devices up, lets in only enrolled ones, and pushes notices to phones. Both ends encrypt with their own keys.',
  });
  d.wire([[200, 104], [660, 104]], { accent: true, start: true }); d.label(430, 86, 'direct, when it can');
  d.wire([[200, 140], [262, 140], [262, 260], [330, 260]], { start: true }); d.label(272, 200, 'relay', { anchor: 'start' });
  d.wire([[530, 260], [598, 260], [598, 140], [660, 140]], { start: true }); d.label(588, 200, 'relay', { anchor: 'end' });
  d.node(20, 80, 180, 76, 'Your computer', { sub: 'device key', focal: true });
  d.node(660, 80, 180, 76, 'Another device', { sub: 'device key' });
  d.node(330, 220, 200, 80, 'Network server', { sub: ['relay · lookup', 'access · push'] });
  d.note(430, 336, 'On one network with no server, devices find each other there and nothing leaves it.', { size: 12 });
  return d;
}

function machinesPaths() {
  const d = new Diagram({
    slug: 'machines-paths', w: 880, h: 330,
    title: 'Two ways to run on another machine',
    desc: 'A machine is reached over ssh: the app bridges into the background process there. A host runs hive host and is reached over hive-net. Either way, terminals and agents run in that machine\'s background process and keep running when you disconnect.',
  });
  d.wire([[210, 140], [280, 140], [280, 76], [360, 76]]); d.label(270, 108, 'ssh', { anchor: 'end' });
  d.wire([[210, 176], [296, 176], [296, 256], [360, 256]]); d.label(286, 226, 'hive-net', { anchor: 'end' });
  d.wire([[560, 76], [660, 76]]);
  d.wire([[560, 256], [660, 256]]);
  d.node(20, 120, 190, 76, 'Your computer', { sub: 'the desktop app', focal: true });
  d.node(360, 40, 200, 72, 'Machine', { sub: 'hive daemon bridge', mono: true });
  d.node(360, 220, 200, 72, 'Host', { sub: 'hive host', mono: true });
  d.node(660, 40, 200, 72, 'Background process', { sub: 'terminals, agents' });
  d.node(660, 220, 200, 72, 'Background process', { sub: 'terminals, agents' });
  d.note(440, 316, 'A machine without hive gets plain ssh terminals, which end when the connection drops.', { size: 12 });
  return d;
}

function agentStates() {
  const d = new Diagram({
    slug: 'agent-states', w: 860, h: 400,
    title: 'Agent states',
    desc: 'An agent starts idle. A turn makes it working; when it asks you it needs you, and your answer makes it working again. When the turn ends it is idle, with a dot until you look. Sleep puts it asleep and Resume wakes it. When its program stops it is exited.',
  });
  dot(d, 130, 52);
  d.wire([[130, 58], [130, 120]]);
  d.wire([[220, 140], [340, 140]]); d.label(280, 122, 'turn starts');
  d.wire([[340, 172], [220, 172]]); d.label(280, 190, 'turn ends · dot');
  d.wire([[500, 140], [620, 140]], { accent: true }); d.label(560, 122, 'asks you');
  d.wire([[620, 172], [500, 172]]); d.label(560, 190, 'you answer');
  d.wire([[110, 192], [110, 280]]); d.label(100, 236, 'Sleep', { anchor: 'end' });
  d.wire([[150, 280], [150, 192]]); d.label(160, 236, 'Resume', { anchor: 'start' });
  d.wire([[420, 192], [420, 280]]); d.label(430, 236, 'program stops', { anchor: 'start' });
  d.node(60, 120, 160, 72, 'idle', { rx: 8, sub: 'grey' });
  d.node(340, 120, 160, 72, 'working', { rx: 8, sub: 'white' });
  d.node(620, 120, 180, 72, 'needs you', { rx: 8, sub: 'amber', warn: true });
  d.node(60, 280, 160, 72, 'asleep', { rx: 8, sub: 'conversation kept' });
  d.node(340, 280, 160, 72, 'exited', { rx: 8, sub: 'red if it failed' });
  d.note(430, 384, 'From any state, a program that stops is exited.', { size: 12 });
  return d;
}

function agentStateSources() {
  const d = new Diagram({
    slug: 'agent-state-sources', w: 890, h: 268,
    title: 'How Hivemind knows',
    desc: "Hooks the agent runs and rules read from its screen both reach the background process. Until the first hook arrives the screen decides; after it, the hooks do. The state goes to the tile, the Layers panel, notifications and your phone.",
  });
  d.wire([[220, 72], [272, 72], [272, 104], [360, 104]], { accent: true }); d.label(282, 88, 'exact', { anchor: 'start' });
  d.wire([[220, 188], [272, 188], [272, 140], [360, 140]]); d.label(282, 164, 'fallback', { anchor: 'start' });
  d.wire([[580, 122], [650, 122]]);
  d.node(20, 40, 200, 64, 'Hooks', { sub: 'the agent tells it' });
  d.node(20, 156, 200, 64, 'Screen rules', { sub: 'detect: in agent.yaml', mono: true });
  d.node(360, 80, 220, 84, 'Background process', { sub: ['one state', 'per agent'], focal: true });
  d.node(650, 80, 220, 84, 'Everywhere it shows', { sub: ['tile, Layers panel,', 'notifications, phone'] });
  d.note(445, 252, 'The screen decides until the first hook arrives; from then on, the hooks do.', { size: 12 });
  return d;
}

function trustBoundary() {
  const d = new Diagram({
    slug: 'trust-boundary', w: 960, h: 540,
    title: 'What can reach what',
    desc: 'Agents and tools run as you, with your files and network. Views and widgets run in a sandbox with no files and no network, and reach the workspace only through the permissions they asked for. Guests come in with a role and programs with a token. Your server sees only encrypted traffic; HiveHub files are checked before they install.',
  });
  d.zone(20, 40, 250, 280, 'Runs as you');
  d.zone(690, 40, 250, 470, 'From outside');
  d.zone(300, 304, 360, 130, 'Sandbox', { sub: 'no files, no network' });
  d.wire([[246, 116], [308, 116], [308, 176], [370, 176]], { start: true });
  d.wire([[246, 244], [324, 244], [324, 200], [370, 200]], { start: true });
  d.wire([[714, 116], [652, 116], [652, 176], [590, 176]]); d.label(662, 146, 'role', { anchor: 'start' });
  d.wire([[714, 244], [636, 244], [636, 200], [590, 200]]); d.label(646, 270, 'token', { anchor: 'start' });
  d.wire([[399, 336], [399, 228]]);
  d.wire([[561, 336], [561, 228]]); d.label(480, 270, 'permissions');
  d.node(44, 84, 202, 64, 'Agents', { sub: 'in your terminals' });
  d.node(44, 212, 202, 64, 'Tools', { sub: 'start switched off' });
  d.node(370, 148, 220, 80, 'The workspace', { sub: 'agents, terminals, board', focal: true });
  d.node(324, 336, 150, 64, 'Views', { sub: 'a sandboxed frame' });
  d.node(486, 336, 150, 64, 'Widgets', { sub: 'a worker' });
  d.node(714, 84, 202, 64, 'Guests', { sub: 'with a role' });
  d.node(714, 212, 202, 64, 'Your programs', { sub: 'with an API token' });
  d.node(714, 330, 202, 64, 'Your server', { sub: 'sees encrypted traffic', dashed: true, plain: true });
  d.node(714, 422, 202, 64, 'HiveHub', { sub: 'files checked first', dashed: true, plain: true });
  return d;
}

function workspaceNesting() {
  const d = new Diagram({
    slug: 'workspace-nesting', w: 880, h: 300,
    title: 'A workspace, its frames and their tiles',
    desc: 'A workspace is one project folder. It holds frames, each bound to one folder: the project, a git worktree, or a folder on another computer. Every tile in a frame runs in that folder.',
  });
  d.zone(20, 30, 840, 250, 'Workspace: one project', { dashed: false });
  const frames = [['Frame: the project', 'Agent', 'Terminal'], ['Frame: a worktree', 'Agent', 'Code'], ['Frame: a machine', 'Agent', 'Terminal']];
  frames.forEach(([name, a, b], i) => {
    const x = 44 + i * 276;
    d.zone(x, 76, 256, 180, name);
    d.node(x + 20, 112, 216, 56, a, { sub: i === 1 ? 'on its own branch' : i === 2 ? 'runs over there' : 'in the project folder' });
    d.node(x + 20, 182, 216, 56, b, { focal: i === 1 && false });
  });
  return d;
}

export default [architecture, desktopProcesses, terminalBytes, driveSockets, viewOpen, phoneFlow, devicesNet, machinesPaths, agentStates, agentStateSources, trustBoundary, workspaceNesting];

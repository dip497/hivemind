// The diagrams of "How it works": what runs where, and how the parts talk.
// Each fact here is traced to the code in reports/research_notes/docs-architecture/map.md.
// Each is at most 800 wide, the guide's column, so its words show at full size.
import { Diagram, C } from './draw.mjs';

const dot = (d, x, y) => d.raw(`<circle cx="${x}" cy="${y}" r="6" fill="${C.ink}"/>`, false);

const ARCH_DESC = 'On your computer the desktop app, the background process that runs your agents, and the hive command. Your own network server relays encrypted traffic to your phone and hosts. Machines are reached over ssh, plugins come from HiveHub.';

function architecture() {
  const d = new Diagram({ slug: 'architecture', w: 800, h: 660, title: 'What runs where', desc: ARCH_DESC });
  d.zone(20, 40, 548, 380, 'Your computer');
  d.zone(580, 192, 204, 120, 'Your server');
  d.zone(284, 524, 500, 116, 'Other machines');
  // Inside your computer.
  d.wire([[222, 120], [316, 120]]); d.label(269, 102, 'drive.sock');
  d.wire([[418, 160], [418, 224]], { start: true }); d.label(428, 192, 'pty socket', { anchor: 'start' });
  d.wire([[316, 252], [222, 252]]); d.label(269, 234, 'runs');
  d.wire([[222, 280], [316, 280]]); d.label(269, 298, 'hooks');
  d.wire([[127, 224], [127, 160]]); d.label(117, 192, 'hive ctl', { anchor: 'end' });
  // Out of your computer.
  d.wire([[520, 100], [596, 100]], { link: true }); d.label(558, 82, 'https');
  d.wire([[520, 128], [560, 128], [560, 256], [596, 256]], { accent: true }); d.label(570, 164, 'encrypted', { anchor: 'start' });
  d.wire([[520, 152], [544, 152], [544, 500], [470, 500], [470, 548]]); d.label(534, 460, 'ssh', { anchor: 'end' });
  d.wire([[650, 288], [650, 380]], { link: true }); d.label(660, 334, 'https', { anchor: 'start' });
  d.wire([[756, 288], [756, 548]], { start: true }); d.label(746, 470, 'relay', { anchor: 'end' });
  d.node(32, 80, 190, 80, 'hive command', { sub: 'you, agents, programs' });
  d.node(316, 80, 204, 80, 'Desktop app', { sub: 'windows and views', focal: true });
  d.node(32, 224, 190, 80, 'Your agents', { sub: 'each in a terminal' });
  d.node(316, 224, 204, 80, 'Background process', { sub: 'runs every agent' });
  d.note(32, 352, 'Stays on this computer: your keys, settings,', { anchor: 'start' });
  d.note(32, 372, 'API tokens and saved screens.', { anchor: 'start' });
  d.note(32, 400, 'Closing the window leaves agents running.', { anchor: 'start' });
  d.node(596, 64, 184, 72, 'HiveHub', { sub: 'plugins', dashed: true, plain: true });
  d.node(596, 220, 180, 68, 'Network server', { sub: 'hive-net serve', mono: true });
  d.node(596, 380, 132, 68, 'Phone page', { sub: 'a browser' });
  d.node(300, 548, 220, 68, 'Machine', { sub: 'over ssh' });
  d.node(580, 548, 188, 68, 'Host', { sub: 'hive host', mono: true });
  return d;
}

// The same parts stacked for a phone screen, so nothing scrolls sideways.
function architecturePhone() {
  const d = new Diagram({ slug: 'architecture-phone', w: 320, h: 884, title: 'What runs where', desc: ARCH_DESC });
  d.zone(8, 30, 304, 496, 'Your computer');
  d.wire([[160, 116], [160, 160]]); d.label(170, 138, 'drive.sock', { anchor: 'start' });
  d.wire([[160, 216], [160, 260]], { start: true }); d.label(170, 238, 'pty socket', { anchor: 'start' });
  d.wire([[160, 316], [160, 360]], { start: true }); d.label(170, 338, 'runs · hooks', { anchor: 'start' });
  d.node(24, 60, 272, 56, 'hive command', { sub: 'you, agents, programs' });
  d.node(24, 160, 272, 56, 'Desktop app', { sub: 'windows and views', focal: true });
  d.node(24, 260, 272, 56, 'Background process', { sub: 'runs every agent' });
  d.node(24, 360, 272, 56, 'Your agents', { sub: 'each in a terminal' });
  d.note(24, 452, 'Stays here: your keys, settings,', { anchor: 'start' });
  d.note(24, 472, 'API tokens and saved screens.', { anchor: 'start' });
  d.note(24, 500, 'Closing the window stops nothing.', { anchor: 'start' });
  d.wire([[86, 526], [86, 572]], { link: true }); d.label(96, 549, 'https', { anchor: 'start' });
  d.wire([[234, 526], [234, 572]]); d.label(224, 549, 'ssh', { anchor: 'end' });
  d.wire([[160, 526], [160, 680]], { accent: true }); d.label(170, 644, 'encrypted', { anchor: 'start' });
  d.node(24, 572, 124, 60, 'HiveHub', { sub: 'plugins', dashed: true, plain: true });
  d.node(172, 572, 124, 60, 'Machine', { sub: 'over ssh' });
  d.zone(8, 660, 304, 100, 'Your server');
  d.node(24, 680, 272, 56, 'Network server', { sub: 'hive-net serve', mono: true });
  d.wire([[86, 736], [86, 800]], { link: true }); d.label(96, 768, 'https', { anchor: 'start' });
  d.wire([[234, 736], [234, 800]], { start: true }); d.label(224, 768, 'relay', { anchor: 'end' });
  d.node(24, 800, 124, 60, 'Phone page', { sub: 'a browser' });
  d.node(172, 800, 124, 60, 'Host', { sub: 'hive host', mono: true });
  return d;
}

function desktopProcesses() {
  const d = new Diagram({
    slug: 'desktop-processes', w: 800, h: 350,
    title: 'Inside the desktop app',
    desc: 'Each window draws the canvas and talks to the main process over IPC. The main process keeps settings and the workspace, listens on the drive socket and the browser tab, and starts the background process and hive-net.',
  });
  d.wire([[220, 80], [300, 80]], { start: true }); d.label(260, 62, 'IPC');
  d.wire([[600, 80], [520, 80]]); d.label(560, 62, 'token');
  d.wire([[220, 256], [260, 256], [260, 104], [300, 104]]); d.label(250, 180, 'WebSocket', { anchor: 'end' });
  d.wire([[410, 120], [410, 220]], { start: true }); d.label(420, 196, 'pty socket', { anchor: 'start' });
  d.wire([[480, 120], [480, 160], [690, 160], [690, 220]], { start: true }); d.label(585, 142, 'local socket');
  d.node(20, 40, 200, 80, 'Window', { sub: 'canvas, tiles, views' });
  d.node(300, 40, 220, 80, 'Main process', { sub: 'settings, workspace', focal: true });
  d.node(600, 40, 180, 80, 'hive ctl, programs', { sub: 'drive.sock', mono: true });
  d.node(20, 220, 200, 72, 'Browser tab', { sub: '127.0.0.1 only' });
  d.node(300, 220, 220, 72, 'Background process', { sub: 'terminals, agents' });
  d.node(600, 220, 180, 72, 'hive-net', { sub: 'your devices' });
  d.note(400, 332, 'Close every window: the background process keeps your terminals and agents running.');
  return d;
}

function terminalBytes() {
  const d = new Diagram({
    slug: 'terminal-bytes', w: 800, h: 316,
    title: 'From an agent to its tile',
    desc: 'The agent program writes to its terminal in the background process, which keeps a copy of each screen and saves it to disk. The app gets the output and draws it in the tile; a tile that attaches again gets the screen replayed.',
  });
  d.wire([[190, 84], [270, 84]]); d.label(230, 66, 'output');
  d.wire([[270, 112], [190, 112]], { dashed: true }); d.label(230, 130, 'keys');
  d.wire([[480, 84], [560, 84]], { accent: true }); d.label(520, 66, 'live');
  d.wire([[560, 112], [480, 112]], { dashed: true }); d.label(520, 130, 'attach');
  d.wire([[375, 136], [375, 216]]); d.label(385, 176, 'saved', { anchor: 'start' });
  d.node(20, 56, 170, 80, 'Agent program', { sub: 'claude, codex, …' });
  d.node(270, 56, 210, 80, 'Background process', { sub: 'a copy of each screen', focal: true });
  d.node(560, 56, 220, 80, 'Desktop app', { sub: 'draws it in the tile' });
  d.node(270, 216, 210, 72, 'Saved screens', { sub: 'sessions/<id>.json', mono: true });
  d.note(520, 244, 'On attach the screen is replayed,', { anchor: 'start' });
  d.note(520, 264, 'then output goes on live.', { anchor: 'start' });
  return d;
}

function driveSockets() {
  const d = new Diagram({
    slug: 'drive-sockets', w: 800, h: 352,
    title: 'Two local sockets',
    desc: 'hive ctl and your programs call the app or hive host on the drive socket with a token. Agent hooks send events to the control socket, which the background process owns and passes on to the app or the host.',
  });
  d.wire([[200, 72], [226, 72], [226, 104], [280, 104]]);
  d.wire([[200, 162], [246, 162], [246, 128], [280, 128]]);
  d.wire([[200, 272], [280, 272]]); d.label(240, 254, 'event');
  d.wire([[450, 116], [540, 116]], { accent: true }); d.label(495, 98, 'token');
  d.wire([[450, 272], [540, 272]]);
  d.wire([[660, 236], [660, 152]]); d.label(670, 194, 'hcp-host.sock', { anchor: 'start' });
  d.node(20, 40, 180, 64, 'hive ctl', { sub: 'you or an agent' });
  d.node(20, 130, 180, 64, 'Your program', { sub: 'SDK and a token' });
  d.node(20, 240, 180, 64, 'Agent hook', { sub: 'started, asks…' });
  d.node(280, 80, 170, 72, 'Drive socket', { sub: 'drive.sock', mono: true });
  d.node(280, 236, 170, 72, 'Control socket', { sub: 'hcp.sock', mono: true });
  d.node(540, 80, 240, 72, 'The app or hive host', { sub: "checks the token's role", focal: true });
  d.node(540, 236, 240, 72, 'Background process', { sub: 'works out states' });
  d.note(400, 336, 'Only your user can open either one: mode 0600, or a named pipe on Windows.');
  return d;
}

function viewOpen() {
  const d = new Diagram({
    slug: 'view-open', w: 800, h: 556,
    title: 'An agent opens a view',
    desc: 'An agent runs hive ctl plugin open; the app asks the window to show the view; the window loads it in a sandboxed frame and hands it a message port; the view says ready, the window says hello with what the view may do, then sends it the workspace.',
  });
  const xs = [100, 300, 500, 700], top = 30, bh = 64, end = 470;
  xs.forEach((x) => d.lifeline(x, top + bh, end));
  const msg = (from, to, y, text, o = {}) => {
    const [a, b] = [xs[from], xs[to]], dir = Math.sign(b - a);
    d.wire([[a + dir * 4, y], [b - dir * 4, y]], o);
    d.label((a + b) / 2, y - 16, text);
  };
  msg(0, 1, 136, 'plugin.open view:<id>');
  msg(1, 2, 180, 'hcp:command');
  msg(2, 3, 224, 'load hm-view://<id>');
  msg(1, 0, 224, 'answer', { dashed: true });
  msg(2, 3, 268, 'message port');
  msg(3, 2, 312, 'ready', { dashed: true });
  msg(2, 3, 356, 'hello', { accent: true });
  msg(2, 3, 400, 'structure, status');
  msg(3, 2, 444, 'command', { dashed: true });
  d.note(600, 498, 'Each command is checked against its permissions.');
  d.node(15, top, 170, bh, 'Agent', { sub: 'hive ctl', mono: true });
  d.node(215, top, 170, bh, 'Main process', { sub: 'drive.sock', mono: true });
  d.node(415, top, 170, bh, 'Window', { sub: 'the renderer' });
  d.node(615, top, 170, bh, 'View', { sub: 'a sandboxed frame', focal: true });
  d.note(400, 538, 'The view has no files, no network and no Node. All it knows comes over its port.');
  return d;
}

function phoneFlow() {
  const d = new Diagram({
    slug: 'phone-flow', w: 800, h: 424,
    title: 'How your phone sees an agent',
    desc: "An agent's hook tells the background process, which works out its state. The app sends the state of every agent to your phone over hive-net, through the relay on your server, encrypted end to end. When the page is closed, a push notice goes through the same server.",
  });
  d.zone(20, 32, 760, 140, 'Your computer');
  d.zone(280, 240, 240, 128, 'Your server');
  d.wire([[190, 102], [270, 102]]); d.label(230, 84, 'hook');
  d.wire([[470, 102], [550, 102]]); d.label(510, 84, 'state');
  d.wire([[700, 140], [700, 304], [500, 304]], { accent: true }); d.label(690, 222, 'agents · needs', { anchor: 'end' });
  d.wire([[300, 292], [220, 292]], { accent: true }); d.label(260, 274, 'relay');
  d.wire([[300, 316], [220, 316]], { dashed: true }); d.label(260, 334, 'push');
  d.node(40, 64, 150, 76, 'Agent', { sub: 'asks something' });
  d.node(270, 64, 200, 76, 'Background process', { sub: 'its state' });
  d.node(550, 64, 210, 76, 'Desktop app', { sub: 'or hive host' });
  d.node(300, 268, 200, 72, 'Network server', { sub: 'hive-net serve', mono: true });
  d.node(40, 268, 180, 72, 'Phone page', { sub: 'your browser', focal: true });
  d.note(400, 404, 'Encrypted end to end: the server passes it on but cannot read it.');
  return d;
}

function devicesNet() {
  const d = new Diagram({
    slug: 'devices-net', w: 800, h: 344,
    title: 'Two devices, one key each',
    desc: 'Two devices talk directly when they can, and through the relay of your own server when they cannot. Your server also looks devices up, lets in only enrolled ones, and pushes notices to phones. Both ends encrypt with their own keys.',
  });
  d.wire([[200, 104], [600, 104]], { accent: true, start: true }); d.label(400, 86, 'direct, when it can');
  d.wire([[200, 140], [250, 140], [250, 260], [300, 260]], { start: true }); d.label(260, 196, 'relay', { anchor: 'start' });
  d.wire([[500, 260], [550, 260], [550, 140], [600, 140]], { start: true }); d.label(540, 196, 'relay', { anchor: 'end' });
  d.node(20, 80, 180, 80, 'Your computer', { sub: 'device key', focal: true });
  d.node(600, 80, 180, 80, 'Another device', { sub: 'device key' });
  d.node(300, 220, 200, 84, 'Network server', { sub: ['relay · lookup', 'access · push'] });
  d.note(400, 332, 'On one network with no server, devices find each other there and nothing leaves it.');
  return d;
}

function machinesPaths() {
  const d = new Diagram({
    slug: 'machines-paths', w: 800, h: 332,
    title: 'Two ways to run on another machine',
    desc: "A machine is reached over ssh: the app bridges into the background process there. A host runs hive host and is reached over hive-net. Either way, terminals and agents run in that machine's background process and keep running when you disconnect.",
  });
  d.wire([[200, 140], [230, 140], [230, 76], [280, 76]]); d.label(220, 104, 'ssh', { anchor: 'end' });
  d.wire([[200, 176], [246, 176], [246, 256], [280, 256]]); d.label(236, 226, 'hive-net', { anchor: 'end' });
  d.wire([[480, 76], [560, 76]]);
  d.wire([[480, 256], [560, 256]]);
  d.node(20, 120, 180, 76, 'Your computer', { sub: 'the desktop app', focal: true });
  d.node(280, 40, 200, 72, 'Machine', { sub: 'hive daemon bridge', mono: true });
  d.node(280, 220, 200, 72, 'Host', { sub: 'hive host', mono: true });
  d.node(560, 40, 220, 72, 'Background process', { sub: 'terminals, agents' });
  d.node(560, 220, 220, 72, 'Background process', { sub: 'terminals, agents' });
  d.note(400, 320, 'A machine without hive gets plain ssh terminals, which end when the connection drops.');
  return d;
}

function agentStates() {
  const d = new Diagram({
    slug: 'agent-states', w: 780, h: 400,
    title: 'Agent states',
    desc: 'An agent starts idle. A turn makes it working; when it asks you it needs you, and your answer makes it working again. When the turn ends it is idle, with a dot until you look. Sleep puts it asleep and Resume wakes it. When its program stops it is exited.',
  });
  dot(d, 115, 52);
  d.wire([[115, 58], [115, 120]]);
  d.wire([[190, 140], [300, 140]]); d.label(245, 122, 'turn starts');
  d.wire([[300, 172], [190, 172]]); d.label(245, 190, 'turn ends');
  d.wire([[450, 140], [560, 140]], { accent: true }); d.label(505, 122, 'asks you');
  d.wire([[560, 172], [450, 172]]); d.label(505, 190, 'you answer');
  d.wire([[95, 192], [95, 280]]); d.label(85, 236, 'Sleep', { anchor: 'end' });
  d.wire([[135, 280], [135, 192]]); d.label(145, 236, 'Resume', { anchor: 'start' });
  d.wire([[375, 192], [375, 280]]); d.label(385, 236, 'program stops', { anchor: 'start' });
  d.node(40, 120, 150, 72, 'idle', { rx: 8, sub: 'grey' });
  d.node(300, 120, 150, 72, 'working', { rx: 8, sub: 'white' });
  d.node(560, 120, 180, 72, 'needs you', { rx: 8, sub: 'amber', warn: true });
  d.node(40, 280, 150, 72, 'asleep', { rx: 8, sub: 'conversation kept' });
  d.node(300, 280, 150, 72, 'exited', { rx: 8, sub: 'red if it failed' });
  d.note(390, 386, 'From any state, a program that stops is exited.');
  return d;
}

function agentStateSources() {
  const d = new Diagram({
    slug: 'agent-state-sources', w: 800, h: 268,
    title: 'How Hivemind knows',
    desc: 'Hooks the agent runs and rules read from its screen both reach the background process. Until the first hook arrives the screen decides; after it, the hooks do. The state goes to the tile, the Layers panel, notifications and your phone.',
  });
  d.wire([[200, 72], [250, 72], [250, 104], [330, 104]], { accent: true }); d.label(290, 86, 'exact');
  d.wire([[200, 188], [250, 188], [250, 140], [330, 140]]); d.label(290, 160, 'fallback');
  d.wire([[530, 122], [590, 122]]);
  d.node(20, 40, 180, 64, 'Hooks', { sub: 'the agent tells it' });
  d.node(20, 156, 180, 64, 'Screen rules', { sub: 'detect: in agent.yaml', mono: true });
  d.node(330, 80, 200, 84, 'Background process', { sub: ['one state', 'per agent'], focal: true });
  d.node(590, 80, 190, 84, 'Where it shows', { sub: ['tile, Layers panel,', 'notifications, phone'] });
  d.note(400, 252, 'The screen decides until the first hook arrives; from then on, the hooks do.');
  return d;
}

function trustBoundary() {
  const d = new Diagram({
    slug: 'trust-boundary', w: 800, h: 520,
    title: 'What can reach what',
    desc: 'Agents and tools run as you, with your files and network. Views and widgets run in a sandbox with no files and no network, and reach the workspace only through the permissions they asked for. Guests come in with a role and programs with a token. Your server sees only encrypted traffic; HiveHub files are checked before they install.',
  });
  d.zone(20, 40, 210, 280, 'Runs as you');
  d.zone(570, 40, 210, 460, 'From outside');
  d.zone(250, 304, 300, 132, 'Sandbox', { sub: 'no files, no network' });
  d.wire([[210, 116], [250, 116], [250, 176], [300, 176]], { start: true });
  d.wire([[210, 244], [266, 244], [266, 200], [300, 200]], { start: true });
  d.wire([[590, 116], [550, 116], [550, 176], [500, 176]]); d.label(540, 136, 'role', { anchor: 'end' });
  d.wire([[590, 244], [534, 244], [534, 200], [500, 200]]); d.label(524, 262, 'token', { anchor: 'end' });
  d.wire([[350, 336], [350, 228]]);
  d.wire([[450, 336], [450, 228]]); d.label(400, 272, 'permissions');
  d.node(40, 84, 170, 64, 'Agents', { sub: 'in your terminals' });
  d.node(40, 212, 170, 64, 'Tools', { sub: 'start switched off' });
  d.node(300, 148, 200, 80, 'The workspace', { sub: 'agents, terminals', focal: true });
  d.node(286, 336, 110, 64, 'Views', { sub: 'a frame' });
  d.node(404, 336, 110, 64, 'Widgets', { sub: 'a worker' });
  d.node(590, 84, 170, 64, 'Guests', { sub: 'with a role' });
  d.node(590, 212, 170, 64, 'Your programs', { sub: 'with a token' });
  d.node(590, 330, 170, 64, 'Your server', { sub: 'encrypted only', dashed: true, plain: true });
  d.node(590, 422, 170, 64, 'HiveHub', { sub: 'files checked', dashed: true, plain: true });
  return d;
}

function workspaceNesting() {
  const d = new Diagram({
    slug: 'workspace-nesting', w: 800, h: 300,
    title: 'A workspace, its frames and their tiles',
    desc: 'A workspace is one project folder. It holds frames, each bound to one folder: the project, a git worktree, or a folder on another computer. Every tile in a frame runs in that folder.',
  });
  d.zone(20, 30, 760, 250, 'Workspace: one project', { dashed: false });
  const frames = [['Frame: the project', 'in the project folder', 'Terminal'], ['Frame: a worktree', 'on its own branch', 'Code'], ['Frame: a machine', 'runs over there', 'Terminal']];
  frames.forEach(([name, sub, b], i) => {
    const x = 36 + i * 248;
    d.zone(x, 76, 232, 180, name);
    d.node(x + 16, 108, 200, 60, 'Agent', { sub });
    d.node(x + 16, 180, 200, 56, b);
  });
  return d;
}

export default [architecture, architecturePhone, desktopProcesses, terminalBytes, driveSockets, viewOpen, phoneFlow, devicesNet, machinesPaths, agentStates, agentStateSources, trustBoundary, workspaceNesting];

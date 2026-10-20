import { Diagram, C } from './draw.mjs';
import howItWorks from './how-it-works.mjs';



function diamond(d, cx, cy, hw, hh, name, sub) {
  const pts = `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`;
  d.raw(`<polygon points="${pts}" fill="${C.paper}"/><polygon points="${pts}" fill="${C.paper2}" stroke="${C.ruleSolid}" stroke-width="1"/>`);
  d.note(cx, cy - 2, name, { color: C.ink, size: 15, weight: 600 });
  d.note(cx, cy + 16, sub);
}

function connectInvite() {
  const d = new Diagram({
    slug: 'connect-invite', w: 640, h: 596,
    title: 'One invite, three answers',
    desc: 'An invite from Settings → Connect is used on the other device and both show three words; on your computer you deny it, let someone else into the workspace, or say it is you, and then the other device confirms the words match to pair as you.',
  });
  d.wire([[320, 80], [320, 112]]);
  d.wire([[320, 172], [320, 196]]);
  d.wire([[220, 240], [100, 240], [100, 372]]); d.label(160, 224, 'Deny');
  d.wire([[420, 240], [540, 240], [540, 372]]); d.label(480, 224, 'Someone else');
  d.wire([[320, 284], [320, 356]]); d.label(332, 320, "It's me", { anchor: 'start' });
  d.wire([[220, 400], [170, 400]]); d.label(195, 384, 'No');
  d.wire([[320, 444], [320, 484]], { accent: true }); d.label(332, 464, 'Yes', { anchor: 'start' });
  d.node(170, 20, 300, 60, 'An invite', { sub: 'Settings → Connect → Connect', rx: 30 });
  d.node(170, 112, 300, 60, 'The other device uses it', { sub: 'both show three words' });
  diamond(d, 320, 240, 100, 44, 'You answer', 'on your computer');
  diamond(d, 320, 400, 100, 44, 'Words match?', 'on the other device');
  d.node(30, 372, 140, 56, 'Nothing kept');
  d.node(460, 372, 160, 56, 'In the workspace', { sub: 'at the role you pick' });
  d.node(220, 484, 200, 56, 'Paired as you', { focal: true, rx: 28 });
  d.note(320, 578, 'A request unanswered for about three minutes counts as Deny.', { size: 12 });
  return d;
}


function phoneTerminal() {
  const d = new Diagram({
    slug: 'phone-terminal-size', w: 640, h: 284,
    title: 'Who sizes the terminal',
    desc: 'A terminal opened on the phone takes the phone size; a desktop key, Fit off, or closing or hiding the terminal gives it back the desktop size; a phone key with Fit on, pressing Fit, or showing the page again takes the phone size again.',
  });
  d.raw(`<circle cx="110" cy="30" r="6" fill="${C.ink}"/>`, false);
  d.wire([[110, 36], [110, 128]]); d.label(120, 70, 'opened on the phone', { anchor: 'start' });
  d.wire([[180, 148], [460, 148]]);
  d.label(320, 132, 'a desktop key'); d.label(320, 114, 'Fit off'); d.label(320, 96, 'terminal closed or page hidden');
  d.wire([[460, 172], [180, 172]]);
  d.label(320, 188, 'a phone key, Fit on'); d.label(320, 206, 'Fit pressed'); d.label(320, 224, 'page shown again');
  d.node(40, 128, 140, 64, 'Phone size', { focal: true, rx: 8 });
  d.node(460, 128, 140, 64, 'Desktop size', { rx: 8 });
  d.note(320, 266, 'Whoever typed last sets the size. Allow, Deny and choosing an option are not typing.', { size: 12 });
  return d;
}

function widgetsRunner() {
  const d = new Diagram({
    slug: 'widgets-runner', w: 640, h: 330,
    title: 'One window runs a widget; everyone sees it',
    desc: "The first of your own windows with the workspace open runs widget.js; what it draws goes live to guests' windows, your other windows and your phone, and a press from any of them goes back to that window.",
  });
  d.wire([[170, 100], [170, 150], [102, 150], [102, 200]]);
  d.wire([[118, 200], [118, 166], [186, 166], [186, 100]], { dashed: true });
  d.wire([[312, 100], [312, 200]]);
  d.wire([[328, 200], [328, 100]], { dashed: true });
  d.wire([[470, 100], [470, 150], [538, 150], [538, 200]]);
  d.wire([[522, 200], [522, 166], [454, 166], [454, 100]], { dashed: true });
  d.node(140, 30, 360, 70, 'The window that runs widget.js', { sub: 'the first of your windows to ask', focal: true });
  d.node(20, 200, 180, 60, "Guests' windows", { sub: 'press if they can edit' });
  d.node(230, 200, 180, 60, 'Your other windows', { sub: 'on any of your devices' });
  d.node(440, 200, 180, 60, 'Your phone', { sub: 'through a widgets view' });
  d.raw(`<line x1="20" y1="286" x2="620" y2="286" stroke="${C.rule}" stroke-width="1"/>`);
  d.raw(`<line x1="20" y1="308" x2="52" y2="308" stroke="${C.soft}" stroke-width="1.25"/>`);
  d.note(60, 312, 'what it draws, live', { size: 12, anchor: 'start' });
  d.raw(`<line x1="200" y1="308" x2="232" y2="308" stroke="${C.soft}" stroke-width="1.25" stroke-dasharray="5,4"/>`);
  d.note(240, 312, 'a press', { size: 12, anchor: 'start' });
  d.note(620, 312, 'Nothing it draws is saved.', { size: 12, anchor: 'end' });
  return d;
}

function issueStates() {
  const d = new Diagram({
    slug: 'workspaces-issue-states', w: 700, h: 316,
    title: 'Issue states',
    desc: 'An issue usually moves backlog, todo, in_progress, in_review, done; cancelled can be set from any state, and nothing enforces the order: any state can be set from any other.',
  });
  const xs = [16, 154, 292, 430, 568], names = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];
  for (let i = 0; i < 4; i++) d.wire([[xs[i] + 116, 68], [xs[i + 1], 68]]);
  d.raw(`<path d="M 74 108 L 74 120 L 626 120 L 626 108" fill="none" stroke="${C.soft}" stroke-width="1"/>`, false);
  for (const x of [212, 350, 488]) d.raw(`<line x1="${x}" y1="108" x2="${x}" y2="120" stroke="${C.soft}" stroke-width="1"/>`, false);
  d.wire([[350, 120], [350, 180]], { dashed: true }); d.label(362, 150, 'from any state', { anchor: 'start' });
  names.forEach((n, i) => d.node(xs[i], 40, 116, 56, n, { rx: 8, focal: n === 'done' }));
  d.node(280, 180, 140, 56, 'cancelled', { rx: 8 });
  d.note(350, 270, 'The order is not enforced: any state can be set from any other.', { size: 12 });
  d.note(350, 292, 'hive close → done · hive close --reason → cancelled · hive reopen → todo', { mono: true });
  return d;
}

function apiDrive() {
  const d = new Diagram({
    slug: 'api-drive', w: 800, h: 260,
    title: 'How a program drives a workspace',
    desc: 'Your program connects to the drive socket on this computer and says hello with its token. Each call is checked against the role the token was made with: an allowed call reaches the workspace, its agents, terminals and board; any other call is refused with FORBIDDEN.',
  });
  const mid = 58;
  d.wire([[190, mid], [250, mid]]); d.label(220, mid - 16, 'token');
  d.wire([[420, mid], [440, mid]]);
  d.wire([[560, mid], [630, mid]], { accent: true }); d.label(595, mid - 16, 'allowed');
  d.wire([[500, mid + 42], [500, 150]], { dashed: true }); d.label(512, 125, 'not allowed', { anchor: 'start' });
  d.node(20, 20, 170, 76, 'Your program', { sub: ['script, dashboard,', 'orchestrator'] });
  d.node(250, 20, 170, 76, 'Drive socket', { sub: 'drive.sock', mono: true });
  diamond(d, 500, mid, 60, 42, 'Its role', '');
  d.node(630, 20, 150, 76, 'The workspace', { sub: ['agents, terminals,', 'board'], focal: true });
  d.node(420, 150, 160, 56, 'Refused', { sub: 'FORBIDDEN', mono: true });
  d.note(400, 244, 'Make the token in Settings → API access, or with hive grant create.', { size: 12 });
  return d;
}

function pluginKinds() {
  const d = new Diagram({
    slug: 'plugins-kinds', w: 700, h: 340,
    title: 'Where each kind of plugin sits',
    desc: 'A view draws the whole workspace. Inside it sit tiles: an agent tile started from an agent file, a terminal, and a tool tile drawn by a tool plugin. A widget is a small card that floats above every view.',
  });
  d.raw(`<rect x="20" y="20" width="660" height="270" rx="10" fill="none" stroke="${C.ruleSolid}" stroke-width="1"/>`, false);
  d.note(38, 44, 'Hivemind window', { anchor: 'start', color: C.ink, size: 13, weight: 600 });
  d.raw(`<rect x="40" y="60" width="430" height="210" rx="8" fill="none" stroke="${C.soft}" stroke-width="1" stroke-dasharray="5,4"/>`, false);
  d.note(56, 86, 'View: draws the workspace (Canvas, Windows, or one you add)', { anchor: 'start', size: 12 });
  d.node(60, 110, 120, 76, 'Agent tile', { sub: 'agent.yaml', mono: true });
  d.node(190, 110, 110, 76, 'Terminal', { sub: 'built in' });
  d.node(310, 110, 145, 76, 'Tool tile', { sub: 'hivemind-tool.json', mono: true });
  d.note(255, 226, 'Each tile is lent to the view.', { size: 12 });
  d.note(255, 244, 'Switching views keeps it running.', { size: 12 });
  d.node(495, 110, 165, 76, 'Widget', { sub: 'widget.json', mono: true, focal: true });
  d.note(577, 212, 'a small card that floats', { size: 12 });
  d.note(577, 230, 'above every view', { size: 12 });
  d.note(350, 322, 'Install any of them from Settings ▸ Plugins, or from HiveHub with hive.', { size: 12 });
  return d;
}

function workflowsLoop() {
  const d = new Diagram({
    slug: 'workflows-loop', w: 700, h: 232,
    title: 'One agent drives others',
    desc: 'You, or a lead agent, start worker agents and send them work with hive ctl. Each worker replies when its turn ends; you collect it with hive ctl read or from your inbox. A worker that stops to ask something tells your inbox, and you answer or approve it.',
  });
  d.wire([[190, 54], [480, 54]]); d.label(335, 38, 'spawn · send');
  d.wire([[480, 102], [190, 102]], { accent: true }); d.label(335, 118, 'reply: read · inbox');
  d.wire([[575, 116], [575, 170], [105, 170], [105, 116]], { dashed: true }); d.label(340, 170, 'asks something → inbox → approve');
  d.node(20, 40, 170, 76, 'You or a lead agent', { sub: 'hive ctl', mono: true, focal: true });
  d.raw(`<rect x="496" y="24" width="190" height="76" rx="6" fill="${C.paper2}" stroke="${C.ruleSolid}" stroke-width="1"/>`);
  d.raw(`<rect x="488" y="32" width="190" height="76" rx="6" fill="${C.paper}" stroke="${C.ruleSolid}" stroke-width="1"/>`);
  d.node(480, 40, 190, 76, 'Worker agents', { sub: 'one per task' });
  d.note(350, 216, 'hive ctl workflow runs fanout, pipeline and mapreduce over many workers.', { size: 12 });
  return d;
}


function hostMove() {
  const d = new Diagram({
    slug: 'host-move', w: 760, h: 270,
    title: 'A host keeps a workspace up',
    desc: 'Move there hands a workspace from your computer to a host that runs hive host; Move here brings it back. While the host has it, guests and your phone reach it there, whatever your computer does.',
  });
  d.wire([[200, 104], [300, 104]], { accent: true }); d.label(250, 88, 'Move there');
  d.wire([[300, 136], [200, 136]]); d.label(250, 152, 'Move here');
  d.wire([[480, 104], [530, 104], [530, 70], [580, 70]], { start: true });
  d.wire([[480, 136], [530, 136], [530, 160], [580, 160]], { start: true });
  d.node(20, 82, 180, 76, 'Your computer', { sub: 'sleeps, travels' });
  d.node(300, 82, 180, 76, 'Host', { sub: 'hive host', mono: true, focal: true });
  d.node(580, 40, 160, 60, 'Guests');
  d.node(580, 130, 160, 60, 'Your phone');
  d.note(380, 240, 'The workspace, its agents and its people stay up while your computer is off.', { size: 12 });
  return d;
}

// HiveHub's registry.ts draft() lists one commit and a SHA-256 per file; plugin-catalog.ts stageEntry() checks each.
const HIVEHUB_DESC = 'Publishing makes HiveHub read your repository at one commit and list every file with its SHA-256 hash. Hivemind reads that listing, downloads each file from your repository at that commit, and checks it against its hash; a file that differs stops the install.';

function hivehubInstall() {
  const d = new Diagram({ slug: 'hivehub-install', w: 790, h: 214, title: 'Where a plugin’s files come from', desc: HIVEHUB_DESC });
  d.wire([[210, 62], [300, 62]]); d.label(255, 46, 'publish');
  d.wire([[490, 62], [580, 62]]); d.label(535, 46, 'listing');
  d.wire([[115, 100], [115, 144], [675, 144], [675, 100]], { accent: true }); d.label(395, 160, 'files');
  d.node(20, 24, 190, 76, 'Your repository', { sub: 'on GitHub, holds the files' });
  d.node(300, 24, 190, 76, 'HiveHub', { sub: ['one commit, each file’s', 'path and SHA-256'], dashed: true, plain: true });
  d.node(580, 24, 190, 76, 'Hivemind', { sub: 'checks every hash', focal: true });
  d.note(395, 198, 'A file that does not match its hash stops the install.', { size: 12 });
  return d;
}

// The same parts stacked for a phone screen.
function hivehubInstallPhone() {
  const d = new Diagram({ slug: 'hivehub-install-phone', w: 320, h: 400, title: 'Where a plugin’s files come from', desc: HIVEHUB_DESC });
  d.wire([[120, 84], [120, 140]]); d.label(132, 112, 'publish', { anchor: 'start' });
  d.wire([[120, 216], [120, 272]]); d.label(132, 244, 'listing', { anchor: 'start' });
  d.wire([[220, 52], [250, 52], [250, 304], [220, 304]], { accent: true }); d.label(262, 178, 'files', { anchor: 'start' });
  d.node(20, 20, 200, 64, 'Your repository', { sub: 'on GitHub, holds the files' });
  d.node(20, 140, 200, 76, 'HiveHub', { sub: ['one commit, each file’s', 'path and SHA-256'], dashed: true, plain: true });
  d.node(20, 272, 200, 64, 'Hivemind', { sub: 'checks every hash', focal: true });
  d.note(160, 366, 'A file that does not match its', { size: 12 });
  d.note(160, 384, 'hash stops the install.', { size: 12 });
  return d;
}

export default [connectInvite, phoneTerminal, widgetsRunner, issueStates, apiDrive, pluginKinds, workflowsLoop, hostMove, hivehubInstall, hivehubInstallPhone, ...howItWorks];

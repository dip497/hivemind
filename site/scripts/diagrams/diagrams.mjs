import { Diagram, C } from './draw.mjs';

function homeYours() {
  const d = new Diagram({
    slug: 'home-yours', w: 940, h: 200,
    title: 'Everything runs on machines you own',
    desc: 'Your phone talks to your own hive-net server, which relays to your computer, which reaches your other machines over ssh.',
  });
  const y = 44, h = 76, mid = y + h / 2;
  d.wire([[160, mid], [236, mid]], { link: true }); d.label(198, mid - 16, 'https');
  d.wire([[420, mid], [496, mid]]); d.label(458, mid - 16, 'relay');
  d.wire([[670, mid], [746, mid]]); d.label(708, mid - 16, 'ssh');
  d.node(20, y, 140, h, 'Your phone', { sub: 'a browser page' });
  d.node(240, y, 180, h, 'Your server', { sub: 'hive-net serve', mono: true });
  d.node(500, y, 170, h, 'Your computer', { sub: 'the Hivemind app', focal: true });
  // Several machines: two flat sheets behind the front one.
  d.raw(`<rect x="766" y="${y - 16}" width="160" height="${h}" rx="6" fill="${C.paper2}" stroke="${C.ruleSolid}" stroke-width="1"/>`);
  d.raw(`<rect x="758" y="${y - 8}" width="160" height="${h}" rx="6" fill="${C.paper}" stroke="${C.ruleSolid}" stroke-width="1"/>`);
  d.node(750, y, 160, h, 'Your machines', { sub: 'servers, VMs, laptops' });
  d.note(470, 168, 'Encrypted end to end: your server passes the traffic on but cannot read it.', { size: 12 });
  return d;
}


function diamond(d, cx, cy, hw, hh, name, sub) {
  const pts = `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`;
  d.raw(`<polygon points="${pts}" fill="${C.paper}"/><polygon points="${pts}" fill="${C.paper2}" stroke="${C.ruleSolid}" stroke-width="1"/>`);
  d.note(cx, cy - 2, name, { color: C.ink, size: 14, weight: 600 });
  d.note(cx, cy + 15, sub, { size: 12 });
}

function connectOffer() {
  const d = new Diagram({
    slug: 'connect-offer', w: 640, h: 596,
    title: 'One offer, three answers',
    desc: 'An offer from Settings → Connect is used on the other device and both show three words; on your computer you deny it, let someone else into the workspace, or say it is you, and then the other device confirms the words match to pair as you.',
  });
  d.wire([[320, 80], [320, 112]]);
  d.wire([[320, 172], [320, 196]]);
  d.wire([[220, 240], [100, 240], [100, 372]]); d.label(160, 224, 'Deny');
  d.wire([[420, 240], [540, 240], [540, 372]]); d.label(480, 224, 'Someone else');
  d.wire([[320, 284], [320, 356]]); d.label(332, 320, "It's me", { anchor: 'start' });
  d.wire([[220, 400], [170, 400]]); d.label(195, 384, 'No');
  d.wire([[320, 444], [320, 484]], { accent: true }); d.label(332, 464, 'Yes', { anchor: 'start' });
  d.node(170, 20, 300, 60, 'An offer', { sub: 'Settings → Connect → Connect', rx: 30 });
  d.node(170, 112, 300, 60, 'The other device uses it', { sub: 'both show three words' });
  diamond(d, 320, 240, 100, 44, 'You answer', 'on your computer');
  diamond(d, 320, 400, 100, 44, 'Words match?', 'on the other device');
  d.node(30, 372, 140, 56, 'Nothing kept');
  d.node(460, 372, 160, 56, 'In the workspace', { sub: 'at the role you pick' });
  d.node(220, 484, 200, 56, 'Paired as you', { focal: true, rx: 28 });
  d.note(320, 578, 'A request unanswered for about three minutes counts as Deny.', { size: 12 });
  return d;
}

function phoneReach() {
  const d = new Diagram({
    slug: 'phone-reach', w: 680, h: 316,
    title: 'How the phone reaches your computer',
    desc: "The phone page talks over https to your own hive-net server, which relays it to your computer and to your other computers and hosts; your computer introduces the phone to those other devices.",
  });
  d.wire([[180, 76], [246, 76]], { link: true }); d.label(213, 60, 'https');
  d.wire([[450, 76], [516, 76]]); d.label(483, 60, 'relay');
  d.wire([[400, 112], [400, 200]]); d.label(388, 156, 'relay', { anchor: 'end' });
  d.wire([[600, 112], [600, 200]], { dashed: true }); d.label(588, 156, 'introduces the phone', { anchor: 'end' });
  d.node(20, 40, 160, 72, 'Phone page', { sub: "your phone's browser" });
  d.node(250, 40, 200, 72, 'Your server', { sub: 'hive-net serve', mono: true });
  d.node(520, 40, 140, 72, 'Your computer', { focal: true });
  d.node(360, 200, 300, 64, 'Your other computers and hosts');
  d.note(340, 298, 'Encrypted end to end: the server relays the traffic but cannot read it.', { size: 12 });
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
  d.note(350, 292, 'hive close → done · hive close --reason → cancelled · hive reopen → todo', { size: 11.5, mono: true });
  return d;
}

export default [connectOffer, phoneReach, phoneTerminal, widgetsRunner, issueStates, homeYours];

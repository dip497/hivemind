/** The brief `hive plugins new` writes as PROMPT.md: what a coding agent needs to build
 *  the plugin and check its own work, with the kind's guide itself, so the two never disagree. */
import widgetGuide from "../../../guide/(extend)/widgets.mdx" with { type: "text" };
import toolGuide from "../../../guide/(extend)/tool-plugins.mdx" with { type: "text" };
import viewGuide from "../../../guide/(extend)/extension-authoring.mdx" with { type: "text" };
import packagesGuide from "../../../guide/(extend)/packages.mdx" with { type: "text" };

export type PluginKind = "widget" | "tool" | "view";

/** A member's place in the package it is written in: the way from its folder to the package's,
 *  and the package's id. */
export interface InPackage { root: string; id: string }

const GUIDE: Record<PluginKind, string> = { widget: widgetGuide, tool: toolGuide, view: viewGuide };
const NOUN: Record<PluginKind, string> = { widget: "widget", tool: "tool plugin", view: "view" };
const WHAT: Record<PluginKind, string> = {
  widget: "a box on the board (and in every view) that its own code draws and keeps state in",
  tool: "a kind of tile, drawn by its own React code inside the app, with the folder and programs of its frame",
  view: "a sandboxed web page that draws the whole workspace its own way",
};

/** Commands with their comments lined up. */
const commented = (lines: Array<[string, string]>): string => {
  const width = Math.max(...lines.map(([c]) => c.length)) + 2;
  return lines.map(([c, why]) => `${c.padEnd(width)}# ${why}`).join("\n");
};

/** How a member's code is checked, installed and shown again after each change: always through
 *  its package, which is what installs. */
function loopInPackage(kind: PluginKind, id: string, p: InPackage): string {
  const record = `${kind}:${id}`;
  return commented([
    ...(kind === "view" ? [["npm install", "once"] as [string, string]] : []),
    [`hive plugins check ${p.root}`, "the package: this member and every other one; file:line for each problem"],
    [`hive plugins install ${p.root}`, "the package, again after each change"],
    [`hive plugins enable ${p.id}`, "once, if it says it is off"],
    [`hive ctl plugin open ${record}`, kind === "view" ? "switch the app to it" : kind === "widget" ? "put one on the board" : "open its tile"],
    ...(kind === "tool" ? [["hive ctl tile look <tile>", "the picture of it, its state and what its code logged"] as [string, string]] : []),
  ]);
}

/** How its code is checked, installed and shown again after each change. */
function loop(kind: PluginKind, id: string, inPackage?: InPackage): string {
  if (inPackage) return loopInPackage(kind, id, inPackage);
  const record = `${kind}:${id}`;
  const check = "hive plugins check .               # its types, its manifest, and its code drawn once; file:line for each problem";
  if (kind === "view") {
    return `npm install                       # once
${check}
npm run dev                       # build, and install into the app (again after each change)
hive plugins enable ${record}     # once
hive ctl plugin open ${record}    # switch the app to it`;
  }
  return `${check}
hive plugins install .            # again after each change
hive plugins enable ${record}     # once
hive ctl plugin open ${record}    # ${kind === "widget" ? "put one on the board" : "open its tile"}${kind === "tool" ? `
hive ctl tile look <tile>         # the picture of it, its state and what its code logged` : ""}`;
}

const SITE = "https://hivemind.griiken.com/guide";

/** A guide page as plain Markdown for an agent: its components taken out, what is only for a
 *  person to look at (the prompt to paste, showcase cards, pictures) left out, links made whole. */
export function plainMarkdown(mdx: string): string {
  return mdx
    .replace(/^---\n[\s\S]*?\n---\n+/, "")
    .replace(/<AgentPrompt[\s\S]*?<\/AgentPrompt>\n*/g, "")
    .replace(/<CardGroup[\s\S]*?<\/CardGroup>\n*/g, "")
    .replace(/<Frame[\s\S]*?<\/Frame>\n*/g, "")
    .replace(/<Diagram[^>]*\/>\n*/g, "")
    .replace(/<LastValidated \/>\n?/g, "")
    .replace(/<Tooltip[^>]*>([\s\S]*?)<\/Tooltip>/g, "$1")
    .replace(/^\s*<\/?(Steps|CodeGroup)>\n/gm, "")
    .replace(/^\s*<Warning>\n/gm, "\n**Warning:** ").replace(/^\s*<\/Warning>\n/gm, "")
    // A step's title becomes a heading, its body no longer indented under it.
    .replace(/^ *<Step title="([^"]*)">\n([\s\S]*?)^ *<\/Step>\n/gm, (_, title: string, body: string) =>
      `#### ${title}\n\n${body.replace(/^ {4}/gm, "")}\n`)
    .replace(/\]\(\/([^)]*)\)/g, (_, to: string) => `](${SITE}/${to.replace(/^([^#]*?)\/?(#|$)/, "$1/$2")})`)
    .replace(/\n{3,}/g, "\n\n");
}

export function pluginBrief(kind: PluginKind, id: string, inPackage?: InPackage): string {
  const at = inPackage?.root ?? ".";
  return `# Build this ${NOUN[kind]}

Hand this file to your coding agent, after writing what you want under **What I want**. Everything
it needs is here: it does not need the Hivemind source.

## What I want

<!-- Say what it should show and do, and for whom. Be concrete. -->

...

---

## What you are building

A **Hivemind ${NOUN[kind]}**: ${WHAT[kind]}. This is \`${id}\`, started in this folder, and it already
runs. The guide below is the whole contract.${inPackage ? `

It is a member of the package \`${inPackage.id}\` in \`${inPackage.root}\`, and installs only with it.` : ""}

## The loop

\`\`\`bash
${loop(kind, id, inPackage)}
\`\`\`

## Check your own work

Declare \`"commands"\` in the manifest and answer them with \`onCommand\` (see the guide): then you can
drive and read the running ${NOUN[kind]} yourself, as any agent can:

\`\`\`bash
hive ctl plugin commands                                  # what is running, and what it answers
hive ctl plugin call ${id} <command> '{"some":"argument"}'
\`\`\`

Give it at least one command that reports what it shows, so you can see that it works.

## Done means

1. \`hive plugins check ${at}\` says ok: its types, its manifest, and its code drawn once.
2. It installs and switches on cleanly: \`hive plugins list\` shows it on, with no problem.
3. \`hive ctl plugin open\` shows it, in the light and the dark theme: colours come from the theme.${kind === "tool" ? "\n   \`hive ctl tile look\` shows it drew what was asked, and its console has no error." : ""}
4. Its commands answer as described, and what it shows follows them.
5. The manifest has a one-line description, a \`category\` and only the permissions it uses;
   README.md says what it does and what it asks for, for its page on HiveHub.

---

${plainMarkdown(GUIDE[kind])}`;
}

/** The brief `hive plugins new package` writes as PROMPT.md: how to fill the package with members
 *  and check, install and look at them, with the packages guide itself. */
export function packageBrief(id: string): string {
  const owner = id.slice(0, id.indexOf("/"));
  return `# Build this package

Hand this file to your coding agent, after writing what you want under **What I want**. Everything
it needs is here: it does not need the Hivemind source.

## What I want

<!-- Say what the package is for, and which tools, widgets, views and themes it should hold. -->

...

---

## What you are building

A **Hivemind package**: one folder holding tools, widgets, views and themes, each in a folder of its own,
that installs, switches on, updates and is removed as one. This is \`${id}\`, started in this
folder. \`hivemind-package.json\` names its members; it holds none yet.

## Add the members

\`\`\`bash
${commented([
  ...(Object.keys(NOUN) as PluginKind[]).map((k): [string, string] => [`hive plugins new ${k} <name> --in .`, `a ${NOUN[k]}: ${WHAT[k]}`]),
  ["hive plugins new theme <name> --in .", "a theme: the look in use as themes/<name>/theme.json, to edit; no code"],
  ["hive plugins add <folder> --to .", `one already written; its id must be ${owner}/<name>`],
])}
\`\`\`

Each member starts in its own folder, with a \`PROMPT.md\` that holds that kind's whole guide: read
it before you write the member's code. Every member's id is \`${owner}/<name>\`.

## The loop

\`\`\`bash
${commented([
  ["hive plugins check .", "the package and every member: types, manifest, code drawn once; file:line for each problem"],
  ["hive plugins install .", "again after each change; it prints what the package holds"],
  [`hive plugins enable ${id}`, "once, if it says it is off (a tool or an agent preset arrives off)"],
  ["hive ctl plugin open <kind>:<member id>", "open a tool's tile, put a widget on the board, switch to a view"],
  ["hive ctl tile look <tile>", "the picture of a tile, its state and what its code logged"],
  [`hive theme use ${id}/<theme>`, "a theme: see it on the app; `hive theme revert` goes back in one step"],
])}
\`\`\`

A theme is data, not code: \`theme.json\` (\`format: 1\`) holds the 13 palette colours, the accent
(a built-in id or \`{ brand, accent }\` colours), and optionally the terminal colours, corners,
fonts (\`.woff2\`), a wallpaper and sounds (\`.ogg\` or \`.mp3\`) from its folder. The check
refuses text below 4.5:1 on its background, and an accent in the colour of "needs you". Only
preview a theme with \`hive theme use\` when the person asked you to change their look.

## Done means

1. \`hive plugins check .\` says ok, for the package and for every member.
2. \`hive plugins install .\` installs it, and \`hive plugins list\` shows every member on, in
   \`[${id} …]\`, with no problem.
3. Each member opens, and \`hive ctl tile look\` shows a tool drew what was asked, with no error in
   its console.
4. \`README.md\` says what the package holds and what each member asks for, for its page on
   HiveHub.

---

${plainMarkdown(packagesGuide)}`;
}

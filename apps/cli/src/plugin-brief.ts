/** The brief `hive plugins new` writes as PROMPT.md: what a coding agent needs to build
 *  the plugin and check its own work, with the kind's guide itself, so the two never disagree. */
import widgetGuide from "../../../guide/(extend)/widgets.mdx" with { type: "text" };
import toolGuide from "../../../guide/(extend)/tool-plugins.mdx" with { type: "text" };
import viewGuide from "../../../guide/(extend)/extension-authoring.mdx" with { type: "text" };

export type PluginKind = "widget" | "tool" | "view";

const GUIDE: Record<PluginKind, string> = { widget: widgetGuide, tool: toolGuide, view: viewGuide };
const NOUN: Record<PluginKind, string> = { widget: "widget", tool: "tool plugin", view: "view" };
const WHAT: Record<PluginKind, string> = {
  widget: "a box on the board (and in every view) that its own code draws and keeps state in",
  tool: "a kind of tile, drawn by its own React code inside the app, with the folder and programs of its frame",
  view: "a sandboxed web page that draws the whole workspace its own way",
};

/** How its code is checked, installed and shown again after each change. */
function loop(kind: PluginKind, id: string): string {
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

export function pluginBrief(kind: PluginKind, id: string): string {
  return `# Build this ${NOUN[kind]}

Hand this file to your coding agent, after writing what you want under **What I want**. Everything
it needs is here: it does not need the Hivemind source.

## What I want

<!-- Say what it should show and do, and for whom. Be concrete. -->

...

---

## What you are building

A **Hivemind ${NOUN[kind]}**: ${WHAT[kind]}. This is \`${id}\`, started in this folder, and it already
runs. The guide below is the whole contract.

## The loop

\`\`\`bash
${loop(kind, id)}
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

1. \`hive plugins check .\` says ok: its types, its manifest, and its code drawn once.
2. It installs and switches on cleanly: \`hive plugins list\` shows it on, with no problem.
3. \`hive ctl plugin open\` shows it, in the light and the dark theme: colours come from the theme.${kind === "tool" ? "\n   \`hive ctl tile look\` shows it drew what was asked, and its console has no error." : ""}
4. Its commands answer as described, and what it shows follows them.
5. The manifest has a one-line description, a \`category\` and only the permissions it uses;
   README.md says what it does and what it asks for, for its page on HiveHub.

---

${plainMarkdown(GUIDE[kind])}`;
}

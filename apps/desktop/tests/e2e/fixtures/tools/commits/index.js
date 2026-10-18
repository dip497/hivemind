// A test tool written against the tool API as any added tool is: the host's React and SDK, a
// setting it reads live, what it chose kept with its tile, the app's diff view, an agent started
// with a permission, and a command an agent runs.
import React, { useEffect, useState } from "hm-plugin://host/react.js";
import { Button, Loading, PatchView, useTileState } from "hm-plugin://host/sdk.js";

const h = React.createElement;
const SEP = "\u001f";

function Commits({ tile, hm, host }) {
  const [match, setMatch] = useState(hm.settings.match ?? "");
  const [commits, setCommits] = useState(null);
  const [chosen, setChosen] = useTileState(hm, "chosen", null);
  const [patch, setPatch] = useState(null);
  useEffect(() => hm.on("settings", (s) => setMatch(s.match ?? "")), [hm]);
  useEffect(() => {
    host.run("git", ["log", `--pretty=format:%H${SEP}%s`]).then((r) => setCommits(r.stdout.split("\n").filter(Boolean).map((line) => {
      const [hash, subject] = line.split(SEP);
      return { hash, subject };
    })));
  }, [host]);
  const shown = (commits ?? []).filter((c) => c.subject.includes(match));
  useEffect(() => hm.onCommand("list", () => shown.map((c) => c.subject)), [hm, shown]);
  useEffect(() => {
    if (!chosen) return;
    setPatch(null);
    host.run("git", ["show", "--format=", "--patch", chosen]).then((r) => setPatch(r.stdout));
  }, [host, chosen]);
  const explain = () => hm.commands.spawnAgent(null, tile.frameId, { name: "Explain", prompt: `Explain commit ${chosen}.` });
  if (commits === null) return h(Loading, { label: "Loading the commits" });
  return h("div", { style: { display: "flex", height: "100%", color: "var(--color-fg)" } },
    h("div", { style: { width: 260, overflow: "auto" } },
      shown.map((c) => h("button", {
        key: c.hash, "data-commit": c.subject, "aria-current": c.hash === chosen, onClick: () => setChosen(c.hash),
        style: { display: "block", width: "100%", textAlign: "left", padding: 6, border: 0, background: "transparent", color: "inherit" },
      }, c.subject))),
    h("div", { style: { flex: 1, minWidth: 0, overflow: "auto" } },
      chosen && hm.capabilities.includes("workspace:spawn") && h(Button, { size: "sm", onClick: explain }, "Ask an agent to explain"),
      chosen && (patch === null ? h(Loading, { label: "Loading the diff" }) : h(PatchView, { patch }))));
}

export default { tiles: { commits: Commits } };

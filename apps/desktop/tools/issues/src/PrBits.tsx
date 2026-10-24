/**
 * An issue's pull request (design jira-sync §11.4), as the PR watcher last saw it: a badge on its
 * card, and a row in the issue panel that opens it and, when review asks for changes or checks
 * fail, starts an agent on them with what GitHub says (the review comments, the failing logs)
 * read through `gh` in the tile's folder.
 */
import { useState } from "react";
import { Button, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, ExternalLink, MessageSquare, Wrench } from "@hivemind/app-ui";
import { PROMPT_MAX, type ViewIssuePr } from "@hivemind/view-sdk/protocol";
import { useIssuesPlugin, write, type Issue } from "./data";

const LOOK: Record<ViewIssuePr["state"], { label: string; color: string; Icon: typeof GitPullRequest }> = {
  open: { label: "open", color: "var(--color-ok)", Icon: GitPullRequest },
  draft: { label: "draft", color: "var(--color-fg3)", Icon: GitPullRequestDraft },
  merged: { label: "merged", color: "var(--color-info)", Icon: GitMerge },
  closed: { label: "closed", color: "var(--color-err)", Icon: GitPullRequestClosed },
};

/** What the badge says beyond the state: review asked for changes, checks failing or running. */
function marks(pr: ViewIssuePr): { text: string; color: string }[] {
  if (pr.state !== "open" && pr.state !== "draft") return [];
  const out: { text: string; color: string }[] = [];
  if (pr.review === "changes_requested") out.push({ text: "changes requested", color: "var(--color-warn)" });
  else if (pr.review === "approved") out.push({ text: "approved", color: "var(--color-ok)" });
  if (pr.checks === "failing") out.push({ text: "checks failing", color: "var(--color-err)" });
  else if (pr.checks === "pending") out.push({ text: "checks running", color: "var(--color-fg3)" });
  return out;
}

/** The card's PR badge: `#12` in its state's colour, and a mark when review or checks need work. */
export function PrBadge({ pr }: { pr: ViewIssuePr }) {
  const look = LOOK[pr.state];
  const m = marks(pr);
  const title = `PR ${pr.repo}#${pr.number}: ${[look.label, ...m.map((x) => x.text)].join(", ")}`;
  return (
    <span className="inline-flex items-center gap-1 text-count font-mono" style={{ color: look.color }} title={title} data-pr-badge={pr.state} data-pr-review={pr.review} data-pr-checks={pr.checks}>
      <look.Icon size={12} />
      #{pr.number}
      {m.map((x) => (
        <span key={x.text} aria-label={x.text} className="inline-block size-1.5 rounded-full" style={{ background: x.color }} />
      ))}
    </span>
  );
}

/** Text from `gh` as an agent's prompt may carry it: no colour codes or other control characters. */
// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "");

/** A prompt that fits: the instruction, then as much of what GitHub said as there is room for. */
function prompt(head: string, said: string, tailLine: string): string {
  const room = PROMPT_MAX - head.length - tailLine.length - 64;
  const body = said.length > room ? `…${said.slice(said.length - room)}` : said;
  return `${head}\n\n\`\`\`text\n${body.replace(/```/g, "'''")}\n\`\`\`\n\n${tailLine}`;
}

/** The issue panel's PR row: the PR, Open, and Address review / Fix CI when they apply. */
export function PrRow({ issue }: { issue: Issue }) {
  const { hm, host, frameId } = useIssuesPlugin();
  const [busy, setBusy] = useState<"review" | "ci" | null>(null);
  const pr = issue.pr;
  if (!pr) return null;
  const look = LOOK[pr.state];
  const open = pr.state === "open" || pr.state === "draft";
  const where = issue.branch ? ` The work is on branch \`${issue.branch}\`: work in its worktree (\`git worktree list\` shows where), commit as "${issue.id}: …"` : "";
  const finish = `When it is done, finish with \`hive ctl complete ${issue.id}\` (it pushes to the open PR).`;
  const spawn = (text: string) => hm.commands.spawnAgent(null, frameId, { prompt: text, name: issue.id });

  const addressReview = async () => {
    setBusy("review");
    const said = await write("Reading the review", Promise.all([
      host.run("gh", ["pr", "view", pr.url, "--comments"]),
      host.run("gh", ["api", `repos/${pr.repo}/pulls/${pr.number}/comments`, "--jq", '.[] | "\\(.path):\\(.line // .original_line // "") \\(.user.login): \\(.body)\\n"']),
    ]).then(([view, lines]) => {
      if (view.code !== 0) throw new Error(view.stderr.trim() || "gh pr view failed");
      return clean(`${view.stdout}${lines.code === 0 && lines.stdout.trim() ? `\n--- comments on lines ---\n${lines.stdout}` : ""}`);
    }));
    setBusy(null);
    if (said === null) return;
    void write("Starting an agent", Promise.resolve().then(() => spawn(prompt(`Address the review on ${pr.url} for ${issue.id} ("${issue.title}").${where}. What the PR and its reviewers say (quoted, from GitHub):`, said, finish))));
  };

  const fixCi = async () => {
    setBusy("ci");
    const said = await write("Reading the checks", (async () => {
      const checks = await host.run("gh", ["pr", "checks", pr.url, "--json", "name,state,bucket,link"]);
      if (checks.code !== 0 && !checks.stdout.trim()) throw new Error(checks.stderr.trim() || "gh pr checks failed");
      const failing = (JSON.parse(checks.stdout || "[]") as { name: string; bucket?: string; state: string; link?: string }[]).filter((c) => c.bucket === "fail" || /FAIL|ERROR/i.test(c.state));
      const runs = [...new Set(failing.map((c) => /\/actions\/runs\/(\d+)/.exec(c.link ?? "")?.[1]).filter((x): x is string => !!x))].slice(0, 3);
      const logs = await Promise.all(runs.map((id) => host.run("gh", ["run", "view", id, "--repo", pr.repo, "--log-failed"])));
      const list = failing.map((c) => `- ${c.name}: ${c.state}${c.link ? ` (${c.link})` : ""}`).join("\n") || "(no failing check named)";
      return clean(`Failing checks:\n${list}\n${logs.map((l, i) => `\n--- run ${runs[i]}, failed steps ---\n${l.stdout.split("\n").slice(-200).join("\n")}`).join("")}`);
    })());
    setBusy(null);
    if (said === null) return;
    void write("Starting an agent", Promise.resolve().then(() => spawn(prompt(`Fix the failing CI on ${pr.url} for ${issue.id} ("${issue.title}").${where}. What GitHub says (quoted):`, said, finish))));
  };

  return (
    <div className="flex flex-col gap-1.5" data-pr-row={pr.state}>
      <div className="flex items-center gap-1.5 text-label" style={{ color: look.color }}>
        <look.Icon size={13} />
        <span className="font-mono">{pr.repo}#{pr.number}</span>
        <span>{look.label}</span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" title="Open the PR" aria-label="Open the PR" onClick={() => host.openUrl(pr.url)}>
          <ExternalLink />
        </Button>
      </div>
      {marks(pr).length > 0 && <div className="text-count text-[var(--color-fg2)]">{marks(pr).map((m) => m.text).join(" · ")}</div>}
      {open && (pr.review === "changes_requested" || pr.checks === "failing") && (
        <div className="flex gap-1">
          {pr.review === "changes_requested" && (
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void addressReview()} title="Start an agent with the review comments (you send or cancel it)" data-address-review>
              <MessageSquare /> {busy === "review" ? "Reading…" : "Address review"}
            </Button>
          )}
          {pr.checks === "failing" && (
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void fixCi()} title="Start an agent with the failing checks' logs (you send or cancel it)" data-fix-ci>
              <Wrench /> {busy === "ci" ? "Reading…" : "Fix CI"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// The workspace as a tree laid out left to right: the workspace, its frames, the worktrees made
// from them, and the tiles in each. Worked out from the structure alone, so it can be checked.

/** Every node with its depth, its parent and its row; leaves take one row each, a parent sits in
 *  the middle of its children. */
export function tree(frames, tiles) {
  const nodes = [];
  const known = new Set(frames.map((f) => f.id));
  const kids = (frameId) => [
    ...frames.filter((f) => f.parentId === frameId).map((f) => ({ kind: "frame", id: f.id, item: f })),
    ...tiles.filter((t) => t.frameId === frameId).map((t) => ({ kind: "tile", id: t.id, item: t })),
  ];
  let row = 0;
  const place = (n, depth, parent) => {
    const children = n.kind === "frame" || n.kind === "root" ? (n.kind === "root" ? n.children : kids(n.id)) : [];
    const node = { ...n, depth, parent, children: undefined };
    nodes.push(node);
    if (!children.length) { node.row = row++; return node; }
    const placed = children.map((c) => place(c, depth + 1, node.id));
    node.row = (placed[0].row + placed[placed.length - 1].row) / 2;
    return node;
  };
  const tops = frames.filter((f) => !f.parentId || !known.has(f.parentId)).map((f) => ({ kind: "frame", id: f.id, item: f }));
  const loose = tiles.filter((t) => !t.frameId || !known.has(t.frameId)).map((t) => ({ kind: "tile", id: t.id, item: t }));
  place({ kind: "root", id: "workspace", children: [...tops, ...loose] }, 0, null);
  return { nodes, rows: Math.max(row, 1), depth: Math.max(...nodes.map((n) => n.depth)) };
}

/** How many issues sit in each state, for the side panel's header. */
export function issueCounts(issues) {
  const out = {};
  for (const i of issues) out[i.state] = (out[i.state] ?? 0) + 1;
  return out;
}

/**
 * The animated "data flow" edge drawn between two agent tiles that are piped
 * (hive_connect) — a dot travels source → target, showing one agent's output
 * feeding another. Our tiles have no <Handle>s, so this is a FLOATING edge: the
 * endpoints are computed from node geometry (the react-flow floating-edges
 * pattern) rather than handle positions.
 */
import { BaseEdge, getBezierPath, useInternalNode, type EdgeProps, type InternalNode } from "@xyflow/react";

/** Intersection of the line (target-center → source-center) with the source
 *  node's rectangle border. From the official react-flow floating-edges example. */
function nodeIntersection(node: InternalNode, target: InternalNode): { x: number; y: number } {
  const w = (node.measured?.width ?? 0) / 2;
  const h = (node.measured?.height ?? 0) / 2;
  const x2 = node.internals.positionAbsolute.x + w;
  const y2 = node.internals.positionAbsolute.y + h;
  const x1 = target.internals.positionAbsolute.x + (target.measured?.width ?? 0) / 2;
  const y1 = target.internals.positionAbsolute.y + (target.measured?.height ?? 0) / 2;
  if (w === 0 || h === 0) return { x: x2, y: y2 };
  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

export function DataFlowEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const sp = nodeIntersection(s, t);
  const tp = nodeIntersection(t, s);
  const [edgePath] = getBezierPath({ sourceX: sp.x, sourceY: sp.y, targetX: tp.x, targetY: tp.y });
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: "var(--color-brand)", strokeWidth: 1.5, strokeOpacity: 0.7, ...style }}
      />
      <circle r={4} fill="var(--color-brand)">
        <animateMotion dur="1.6s" repeatCount="indefinite" path={edgePath} />
      </circle>
    </>
  );
}

/** The persistent "spawned-by" wire: a static DASHED floating edge from a parent
 *  agent to a child it spawned (sub-agent or workflow worker). Deliberately quiet
 *  — muted, no traveling dot — so it reads as a structural parentage link, not the
 *  animated data pipe. Drawn for EVERY spawn, independent of the report pipe. */
export function SpawnEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const sp = nodeIntersection(s, t);
  const tp = nodeIntersection(t, s);
  const [edgePath] = getBezierPath({ sourceX: sp.x, sourceY: sp.y, targetX: tp.x, targetY: tp.y });
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{ stroke: "var(--color-fg3)", strokeWidth: 1.5, strokeOpacity: 0.5, strokeDasharray: "5 5", ...style }}
    />
  );
}

/** Stable edgeTypes map for <ReactFlow edgeTypes={…}>. */
export const pipeEdgeTypes = { dataflow: DataFlowEdge, spawn: SpawnEdge };

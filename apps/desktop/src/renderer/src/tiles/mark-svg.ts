import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentIcon } from "../agents";
import { KindMark } from "./mark";

/** A tile's mark as `<svg>` markup, for a view to draw: an agent's logo, else its kind's icon. A
 *  kind marked by a text glyph has none. */
export function tileMarkSvg(kind: string, agent: string | undefined): string | undefined {
  const html = renderToStaticMarkup(agent ? createElement(AgentIcon, { id: agent, size: 16 }) : createElement(KindMark, { kind, size: 16 }));
  return html.startsWith("<svg") ? html : undefined;
}

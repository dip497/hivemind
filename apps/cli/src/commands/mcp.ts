import { defineCommand } from "citty";
import { runStdio } from "@hivemind/mcp";

/** `hive mcp-stdio` — start the MCP server on stdio.
 *  Used by `.mcp.json` at a workspace root so claude auto-loads hive tools. */
export const mcpStdioCmd = defineCommand({
  meta: {
    name: "mcp-stdio",
    description: "Run the hivemind MCP server on stdio (used by .mcp.json)",
  },
  async run() {
    await runStdio();
  },
});

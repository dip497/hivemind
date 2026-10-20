// The Add menu, the Plugins page and HiveHub list plugins under the same headings in the same order.
import { describe, expect, it } from "bun:test";
import { groupByCategory } from "../src/category";

describe("grouping by category", () => {
  it("puts each item under its category, in the catalogue's order, and leaves out empty ones", () => {
    const items = [
      { name: "Pet", category: "fun" as const },
      { name: "Terminal", category: "code" as const },
      { name: "Ports", category: "monitoring" as const },
      { name: "Code", category: "code" as const },
    ];
    expect(groupByCategory(items, (i) => i.category).map(([cat, list]) => [cat, list.map((i) => i.name)])).toEqual([
      ["code", ["Terminal", "Code"]],
      ["monitoring", ["Ports"]],
      ["fun", ["Pet"]],
    ]);
  });
});

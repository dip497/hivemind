// tree-sitter's bundle asks the page for its own script's address as it loads; a Worker has no page.
if (typeof document === "undefined") Object.assign(globalThis, { document: { currentScript: { src: self.location.href } } });
export {};

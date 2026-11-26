import { describe, expect, test } from "bun:test";
import { openerFor } from "./opener";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings-schema";

const links = DEFAULT_SETTINGS.links;
const at = (thing: string, cwd: string | null = "/repo/src") => ({ thing, cwd, folders: ["/repo"] });

describe("openerFor: web addresses", () => {
  test("a page goes where the setting says; one on this computer always to a Browser tile", () => {
    expect(openerFor(at("https://example.com/a"), links)).toEqual({ to: "system-browser", url: "https://example.com/a" });
    expect(openerFor(at("https://example.com/a"), { ...links, web: "tile" })).toEqual({ to: "browser-tile", url: "https://example.com/a" });
    for (const url of ["http://localhost:5173/", "http://127.0.0.1:8080", "http://[::1]:3000/x"]) {
      expect(openerFor(at(url), links)).toEqual({ to: "browser-tile", url });
    }
  });

  test("a kind of link the person allowed goes to the system from their click only; one that runs code is never allowed", () => {
    const click = { ...at("vscode://file/x"), person: true };
    expect(openerFor(click, { ...links, allowedSchemes: ["vscode"] })).toEqual({ to: "system-browser", url: "vscode://file/x" });
    expect(openerFor(click, links)).toMatchObject({ to: "ask", scheme: "vscode" });
    const unasked = openerFor(at("vscode://file/x"), { ...links, allowedSchemes: ["vscode"] });
    expect([unasked.to, "scheme" in unasked]).toEqual(["ask", false]);
    const never = openerFor(at("javascript:alert(1)"), { ...links, allowedSchemes: ["javascript"] });
    expect([never.to, "scheme" in never]).toEqual(["ask", false]);
  });

  test("a host that only starts with localhost is not this computer", () => {
    expect(openerFor(at("http://localhost.evil.com/"), links).to).toBe("system-browser");
  });

  test("mail goes to the system; any other scheme is asked about", () => {
    expect(openerFor(at("mailto:me@example.com"), links).to).toBe("system-browser");
    for (const url of ["javascript:alert(1)", "vscode://file/x", "ftp://example.com/f", "smb://box/share"]) {
      expect(openerFor(at(url), links).to).toBe("ask");
    }
  });
});

describe("openerFor: files", () => {
  test("a bare name with a line opens in Code at that line, read from the current folder", () => {
    expect(openerFor(at("README.md:12"), links)).toEqual({ to: "code", path: "/repo/src/README.md", line: 12 });
    expect(openerFor(at("a.ts:4:7"), links)).toEqual({ to: "code", path: "/repo/src/a.ts", line: 4, col: 7 });
    expect(openerFor(at("./lib/b.ts:3,"), links)).toEqual({ to: "code", path: "/repo/src/lib/b.ts", line: 3 });
  });

  test("a file: URL keeps its line", () => {
    expect(openerFor(at("file:///repo/x%20y.ts:9"), links)).toEqual({ to: "code", path: "/repo/x y.ts", line: 9 });
  });

  test("a path outside the workspace is asked about, however it is written", () => {
    for (const p of ["/repo-evil/x.ts", "/repo/../etc/passwd", "../../etc/hosts", "~/notes.md", "/etc/passwd"]) {
      expect(openerFor(at(p), links).to).toBe("ask");
    }
    expect(openerFor(at("x.ts", null), links).to).toBe("ask");
  });

  test("the person's click on an absolute path outside the workspace opens it; an agent's or a view's never does", () => {
    const person = (thing: string, cwd: string | null = "/repo/src") => ({ ...at(thing, cwd), person: true });
    expect(openerFor(person("/tmp/shots/crop2.png"), links)).toEqual({ to: "image", path: "/tmp/shots/crop2.png" });
    expect(openerFor(person("file:///tmp/report.pdf"), links)).toEqual({ to: "os", path: "/tmp/report.pdf" });
    expect(openerFor(person("/tmp/notes.md:4:2"), links)).toEqual({ to: "code", path: "/tmp/notes.md", line: 4, col: 2 });
    expect(openerFor(person("/tmp/notes.md"), { ...links, files: "system" })).toEqual({ to: "os", path: "/tmp/notes.md" });
    expect(openerFor(person("/tmp/site/index.html"), links)).toEqual({ to: "browser-tile", url: "file:///tmp/site/index.html" });
    expect(openerFor(person("/tmp/shots/"), links)).toEqual({ to: "os", path: "/tmp/shots/" });
    expect(openerFor(person("/tmp/run.exe"), links)).toEqual({ to: "ask", path: "/tmp/run.exe", why: "outside the workspace: /tmp/run.exe" });
    expect(openerFor({ thing: "C:\\shots\\a.png", cwd: "C:\\repo", folders: ["C:\\repo"], person: true }, links)).toEqual({ to: "image", path: "C:/shots/a.png" });
    for (const p of ["/tmp/shots/crop2.png", "/tmp/report.pdf", "/tmp/notes.md", "/tmp/site/index.html", "/tmp/shots/", "/etc/passwd"]) expect(openerFor(at(p), links).to).toBe("ask");
  });

  test("the person's click still stays in the workspace for a relative path or one on another machine", () => {
    expect(openerFor({ ...at("../../etc/hosts.png"), person: true }, links).to).toBe("ask");
    expect(openerFor({ ...at("crop.png", "/tmp"), person: true }, links).to).toBe("ask");
    const remote = { thing: "/tmp/crop.png", cwd: "ssh://me@box/home/me/repo", folders: ["ssh://me@box/home/me/repo"], person: true };
    expect(openerFor(remote, links).to).toBe("ask");
  });

  test("a picture opens in the Image tile, before any other rule", () => {
    for (const p of ["shot.png", "a.JPG", "logo.svg", "x.webp", "y.avif"]) {
      expect(openerFor(at(p), { ...links, files: "system" }).to).toBe("image");
    }
  });

  test("files: system hands viewable files to the system's app and keeps the rest in Code", () => {
    const system = { ...links, files: "system" as const };
    expect(openerFor(at("notes.md:3"), system)).toEqual({ to: "os", path: "/repo/src/notes.md" });
    expect(openerFor(at("Makefile"), system)).toEqual({ to: "code", path: "/repo/src/Makefile" });
  });

  test("what may run is never handed to the system", () => {
    for (const p of ["setup.exe", "app.AppImage.so", "launch.desktop.deb", "pkg.msi"]) {
      const o = openerFor(at(p), links);
      expect(o.to === "os").toBe(false);
    }
    expect(openerFor(at("run.exe"), links).to).toBe("ask");
    for (const p of ["setup.py", "build.sh", "index.js", "deploy.ps1", "tool.pl", "/tmp/x/run.rb"]) {
      const o = openerFor({ ...at(p), person: true }, { ...links, files: "system" });
      expect([p, o.to]).toEqual([p, "code"]);
    }
    expect(openerFor(at("doc.pdf"), links)).toEqual({ to: "os", path: "/repo/src/doc.pdf" });
  });

  test("a page of the workspace opens in a Browser tile", () => {
    expect(openerFor(at("site/index.html:4"), links)).toEqual({ to: "browser-tile", url: "file:///repo/src/site/index.html" });
  });

  test("a file on another machine opens in Code, never the system's app", () => {
    const remote = { thing: "a.ts:2", cwd: "ssh://me@box/home/me/repo", folders: ["ssh://me@box/home/me/repo"] };
    expect(openerFor(remote, { ...links, files: "system" })).toEqual({ to: "code", path: "ssh://me@box/home/me/repo/a.ts", line: 2 });
    expect(openerFor({ ...remote, thing: "doc.pdf" }, links).to).toBe("ask");
  });
});

test("settings: links read from settings.json, a bad value kept as the default", () => {
  expect(mergeSettings({ links: { web: "tile", files: "system", allowedSchemes: ["VSCode", "javascript", "https", 7] } }).links).toEqual({ web: "tile", files: "system", allowedSchemes: ["vscode"] });
  expect(mergeSettings({ links: { web: "chrome", files: 3 } }).links).toEqual({ web: "system", files: "code", allowedSchemes: [] });
  expect(mergeSettings(undefined).links).toEqual({ web: "system", files: "code", allowedSchemes: [] });
});

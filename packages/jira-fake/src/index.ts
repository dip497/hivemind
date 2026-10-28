import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SiteZ, type Site } from "./site.js";

export * from "./site.js";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

/** Every fixture site by name (`cloud-scrum-company`, …), parsed and defaulted. */
export function loadSites(dir = FIXTURES_DIR): Map<string, Site> {
  const sites = new Map<string, Site>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".site.json")).sort()) {
    const site = SiteZ.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
    sites.set(site.name, site);
  }
  return sites;
}

export function loadSite(name: string, dir = FIXTURES_DIR): Site {
  const site = loadSites(dir).get(name);
  if (!site) throw new Error(`no fixture site named ${name}`);
  return site;
}

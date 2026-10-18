# Dependency audit

The repository's lockfiles checked against [OSV](https://osv.dev), the public database of known
vulnerabilities: each vulnerable package with its worst severity, every advisory against it (id,
summary, CVE) and the version that fixes it. Filter by severity; open an advisory on osv.dev; "Ask
an agent to upgrade" starts one in the tile's frame with the list (you read the prompt before it
is sent).

It reads `Cargo.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `uv.lock`,
`poetry.lock` and `requirements.txt` (only `==` pins) anywhere git tracks them, outside
`node_modules`. All packages go in batches of up to 1000 to `POST /v1/querybatch`, then each
advisory found is read once from `GET /v1/vulns/<id>`; its severity is the database's own word, or
the band of its CVSS 3 score. Answers are kept for ten minutes; "Check again" asks afresh.

```bash
hive tools install examples/tools/dependency-audit
hive plugins enable tool:dip497/dependency-audit
hive ctl open-tool dip497/dependency-audit/audit
```

An agent asks it, while its tile is open:

```bash
hive ctl plugin call dip497/dependency-audit audit      # every finding
hive ctl plugin call dip497/dependency-audit packages   # packages per lockfile
```

It asks for two permissions: start agents (`workspace:spawn`) and tell an agent something
(`workspace:prompt`). It needs `git` and `curl`, and sends package names and versions to
api.osv.dev.

## How it was made

Built by a coding agent (Claude) from the tool-plugin contract (the brief
`hive tools new` writes, and the tool plugin guide). It uses `host.run` of `git ls-files`, `cat`
and `curl` (the batch query's body on stdin), `host.openUrl` for an advisory, and
`hm.commands.spawnAgent` with the permissions above. The parsing is in `lib.js`, tested on real
lockfile and OSV output.

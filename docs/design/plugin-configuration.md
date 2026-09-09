# Plugin configuration and agent lifecycle

Status: target architecture, not implemented policy. Priority: performance, view
configuration, agent plugin lifecycle, then marketplace distribution.

## Performance is a host contract

The host owns terminals, workspace identity, persistence, input, and agent processes.
Views present them. Switching or disabling a view must preserve sessions and editor
buffers. A broken view must leave a route back to Canvas.

Measure input-to-paint latency, frame intervals, long tasks, switch/resize latency,
idle CPU, and memory on a documented machine with reproducible workspace fixtures.
Compare plugins against Canvas under the same load. Average FPS hides stalls: collect
p50/p95/p99 latency and missed-frame counts. The existing +5 ms typing gate remains a
requirement, not a claim that today's implementation passes it. At 60 Hz a frame is
about 16.7 ms; application work gets only part of that budget. Higher refresh rates
need a tighter budget.

Only visible views animate; hidden views pause media and rendering. Use demand
rendering for static scenes, bounded pixel ratios, and explicit 3D quality controls.
Selection and pointer updates must not rebuild every terminal's props. Registry
scans, schema parsing, hashing, and file writes stay outside the input/render path.
Configuration cannot disable host safety limits.

## Views declare settings; the host renders controls

Every view, including Canvas, Windows, and World, declares a versioned settings
schema: booleans, bounded numbers, enums, colors, text, and host-selected asset
references. Fields include defaults, labels, groups, scope, and whether changes apply
live or need a view reload. Start with a small data vocabulary, without arbitrary
HTML controls, executable validators, or unrestricted file access.

Toolbar placement, camera/navigation controls, scene density, lighting, background,
animation, and quality belong here. Plugins can expose fields without another
hardcoded panel. The host supplies validation, accessible controls, reset, CLI paths,
and import/export.

Separate user preferences, workspace overrides, and layout/session state. Camera
movement does not write the settings file every frame; layout has its own bounded
checkpoint path. Changes produce validated, versioned events, subscribed by relevant
plugin/path instead of polling.

Preference precedence: plugin defaults, user defaults, workspace overrides, explicit
session overrides. Permissions are different: lower-trust layers can restrict but
cannot grant access. Reject incompatible settings and preserve the last valid
configuration. Schema changes need versioned migration and recoverable backups.

## All agents are plugins

Ship the default catalog as bundled plugins implementing the same versioned contract
as installed plugins. Membership is discovery, not permission to spawn. Replace the
two manual registrations with one source that produces browser-safe metadata and
host-only adapter registrations. Never import spawn code or secrets into the renderer.

Each plugin declares identity, compatibility, models/default selection, capabilities,
spawn support, status events, resume behavior, and configuration schema. Built-ins
can retain audited host code while sharing lifecycle and policy APIs. Downloadable
arbitrary adapters require a separate isolation boundary before support is enabled;
plugin naming does not make importing code into Electron main safe.

| Action | Effect |
|---|---|
| Install | Validate/register; no agents start |
| Enable | Become eligible for approved starts |
| Disable | Refuse all new starts, including CLI and nested requests |
| Stop run | Stop sessions recorded as belonging to that run |
| Remove | Remove registration/future launch access; handle live sessions explicitly |

Disabling must not silently kill work. Pin an active adapter version until its
sessions finish. Removing a bundled agent hides/disables its registration, and app
updates respect that choice. Removal does not uninstall an independently installed
CLI or delete its credentials/history.

Models belong to each provider, replacing one global Claude-shaped field. Expose
catalog defaults and user overrides; omit a model flag for the provider default.
Names never become executable paths or shell fragments. Refresh model discovery
outside rendering, cache metadata, and show unavailable/stale results accurately.
Secrets remain in provider-owned storage; export references, never API keys.
Catalog metadata loads without executing adapters. Prepare hooks/assets lazily for
enabled providers when needed, with bounded startup work; adding catalog entries
must not increase every view switch's cost.

## TOML configuration, separate trusted grants

Choose TOML for human editing, JSON for machine output and schemas. Supporting YAML
too adds parser/precedence complexity. Existing JSON settings require an explicit
migration before TOML becomes authoritative; do not create two writable sources of
truth. This is a proposed configuration, not currently supported syntax:

```toml
[agents.pi]
enabled = true
model = "default"

[agents.pi.spawn]
approval = "ask"
max_concurrent = 2
allow_child_agents = false

[views.world]
quality = "balanced"
animate = false

[views.world.toolbar]
position = "automatic"
```

These are requested preferences. Approved grants live outside the repository and
package, bound to plugin digest, workspace identity, requester, capabilities, and
effective provider settings. Repository TOML cannot approve itself, raise a limit,
enable a disabled provider, or select bypass permissions.

Spawn approval controls process creation. It does not itself restrict a launched
CLI's files, commands, network, or model spending. Translate tool permissions only
when an adapter implements enforcement; otherwise refuse that policy or explicitly
require the provider's own approval flow. Supervising agents cannot grant themselves
more authority than their delegated scope.

A separate grants file is an application boundary, not OS isolation. An unrestricted
CLI running as the same user can edit user-owned files or launch another process
outside Hivemind. Strict prevention requires isolated workers and an authenticated
broker; a shared HCP token cannot distinguish a human approver from every agent that
can read it. Document whether each guarantee covers mediated launches or OS-enforced
access, and do not present the former as the latter.

## CLI and desktop use the same authority

Proposed flow: `config validate/diff`, `plugins plan`, `plugins approve`, then
`plugins start`, with JSON results and persistent request/run ids. Names can change.
Desktop actions call the same host handlers. Noninteractive calls return a structured
approval-required result; missing input is never consent.

Every launch path reaches one policy check: desktop, CLI/HCP, package startup, plugin
commands, and nested agent requests. Immediately before reserving a spawn slot,
validate enabled state, approved digest, workspace, model, provider support, requester
scope, and concurrency budget. Use argv arrays, not shell interpolation. Recheck when
configuration/content changes. Default catalog availability is not an automatic grant.

CLI approval can authorize an unchanged plan for subsequent one-action starts within
its scope. Grants remain inspectable/revocable. Revocation blocks future starts;
stopping existing processes is separate.

## Implementation checkpoints

1. Finish render/input gates and settings concurrency fixes.
2. Add a pure settings schema/precedence resolver; migrate one built-in view as proof.
3. Add spawn-policy evaluation and denial tests, then route every launch path through
   it before exposing approval commands.
4. Migrate one built-in provider completely: disable, resume, default model, removal,
   and CLI/UI parity. Then move the rest of the catalog.
5. Connect package installation/startup to these contracts before remote marketplace
   installation. See [package-marketplace.md](package-marketplace.md).

Breaking changes are acceptable with migrations and preserved live work. A settings
screen and plugin directories alone do not prove enforcement or performance.

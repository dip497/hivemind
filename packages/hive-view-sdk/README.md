# @hivemind/view-sdk

The client a Hivemind view uses to talk to the app: a view is a small web page, sandboxed, that
draws the workspace its own way.

How to write one: https://hivemind.griiken.com/guide/extension-authoring/ (what it may call, its
permissions and manifest are in that page's View reference; how the protocol works:
https://hivemind.griiken.com/guide/view-protocol/).

```sh
hive plugins new view <name>          # a starter, with this SDK's source as its types
hive plugins check <folder>           # types, manifest, and one draw against a fake host
hive plugins install <folder>         # it appears in the app's view switcher
```

This is not an npm package. The app builds it into itself and serves it to every view at
`/__sdk.js`, with an import map that resolves `@hivemind/view-sdk` there, so a view leaves it out
of its bundle and always gets the SDK of the app it runs in.

Test a view without the app with `fakeHost()` from `@hivemind/view-sdk/testing`: it greets the view
as the app does and says why the app would refuse what the view sends.

It is also the client of a **live wallpaper**, a scene drawn behind the canvas whose life moves by
itself and plays with the pointer: `connectWallpaper()` (`src/wallpaper-client.ts`) speaks live
wallpaper protocol 2 (`src/wallpaper.ts`). It is told its size, the theme's colours and font,
whether to run, and the pointer and clicks over empty canvas, and nothing of the workspace; it says
`ready` and `drawn`. `animate({ step, draw, settle })` runs it on the app's clock, and
`fakeWallpaperHost()` (`@hivemind/view-sdk/testing`) tests one without the app. How to make one:
https://hivemind.griiken.com/guide/live-wallpapers/.

```sh
hive plugins new wallpaper <name>     # a package holding a working one
```

## Contributing

The protocol, and each command's permission (`COMMAND_PERMISSION`), are in `src/protocol.ts`, checked against
[`conformance/view-commands.json`](https://github.com/dip497/hivemind/blob/main/conformance/view-commands.json).
Complete views to read: `views/agent-board` and `views/widgets` in
[hivemind-plugins](https://github.com/dip497/hivemind-plugins).

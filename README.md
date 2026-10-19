<p align="center">
  <img src="assets/icon.png" alt="Hivemind" width="76" />
</p>

<h1 align="center">Hivemind</h1>

<p align="center"><b>Your agents build the workspace they work in.</b></p>

<p align="center">
  <a href="https://hivemind.griiken.com/">Website</a> ·
  <a href="https://hivemind.griiken.com/guide/">Guide</a> ·
  <a href="https://hivehub.griiken.workers.dev/">HiveHub</a> ·
  <a href="https://github.com/dip497/hivemind/releases">Releases</a>
</p>

> [!NOTE]
> **Yes, it's Electron. Please don't kill me.** 🙏 I'm a backend guy, and plugins your agents write
> are web code anyway. Send hate mail to `/dev/null`.

<p align="center">
  <a href="https://hivemind.griiken.com/"><img alt="An agent was asked to show the workspace as islands. It installed the Island view and switched to it; its live terminal sits beside the islands" src="site/public/shots/hero/step-view.webp" /></a>
</p>

<p align="center"><sub>One prompt: <i>"Show my workspace as islands."</i> The agent installed the Island view and switched the app to it.</sub></p>

Every coding agent on one board. Ask one for a view, a widget or a tool, and it builds it for you.
Open source, on your computer, no account.

- **Your own workspace.** Views, widgets and tools are plugins your agents write.
- **Agents drive it.** `hive ctl` and an API let agents and scripts run the whole board.
- **Anywhere.** Agents on other machines over ssh, and on your phone.

<table>
  <tr>
    <td><img alt="An agent asked for a CI light puts the widget on the board and sets it to running" src="site/public/shots/hero/step-widget.webp" /></td>
    <td><img alt="The Flaky tests tool: five tests run eight times, two of them flaky" src="site/public/shots/showcase/flaky-tests-board.webp" /></td>
  </tr>
  <tr>
    <td align="center"><sub>"Put a CI light where I can see it."</sub></td>
    <td align="center"><sub>A tool: which tests are flaky</sub></td>
  </tr>
  <tr>
    <td><img alt="The Constellation view: every agent as a star" src="site/public/shots/showcase/constellation-board.webp" /></td>
    <td align="center"><img alt="The phone page listing projects and their agents" src="site/public/shots/phone-home.webp" width="220" /></td>
  </tr>
  <tr>
    <td align="center"><sub>A view: every agent as a star</sub></td>
    <td align="center"><sub>Your agents, on your phone</sub></td>
  </tr>
</table>

<p align="center">
  <a href="https://hivehub.griiken.workers.dev/p/@dip497/dog"><img alt="Biscuit, a pixel-art dog, walking along the bottom of the window" src="site/public/shots/showcase/dog.webp" width="720" /></a><br />
  <sub>Yes, there is a dog. His name is Biscuit. He is a widget.</sub>
</p>

More on [HiveHub](https://hivehub.griiken.workers.dev/).

## Install

Linux x86_64 and macOS on Apple Silicon:

```bash
bash <(curl -fsSL https://hivemind.griiken.com/install.sh)
```

Windows x64, in PowerShell:

```powershell
irm https://hivemind.griiken.com/install.ps1 | iex
```

[Contributing](./CONTRIBUTING.md) · [MIT licence](./LICENSE)

---
title: Phone and browser
description: Answer and drive your agents from your phone's browser, or open the whole app in a browser tab.
---

The phone page is a web page your phone's browser opens. From it you answer your agents, start and
stop them, and watch their terminals. It comes from your own [network server](../self-hosting/)
and all its traffic goes through it, encrypted end to end.

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/phone-reach.svg" width="680" height="316" alt="The phone page talks over https to your own server running hive-net serve. The server relays it to your computer and to your other computers and hosts, and your computer introduces the phone to those other devices. The traffic is encrypted end to end; the server cannot read it." /></div>
  <figcaption>How the phone reaches your computer</figcaption>
</figure>

## Before you start

You need a network server that serves the page, with a public name (a phone's browser needs
https). The Docker setup in [Your own network server](../self-hosting/) serves it at `/phone/`.
Or let an agent set it up: **Settings → Connect → Connect** → **Phone browser** tab →
**Set it up with an agent**.

## Pair

1. On the computer: **Settings → Connect → Connect**, tab **Phone browser**.
2. Scan the QR code with the phone. Tap **Connect**.
3. If both screens show the same three words, press **It's me — the words match** on the
   computer, then **Yes** on the phone.

Add the page to your home screen: it opens at once, offline too, and updates itself. To unpair,
**Unpair** under **Your devices**, or **Devices → Forget this computer** on the phone.

## What you can do

| Screen | Does |
|---|---|
| **Home** | What needs you first, then working agents, pinned tiles, then every project. Hold or swipe a row to **Stop** or **Close**. **+** starts an agent (with up to four photos). |
| An agent's chat | The conversation, with each tool use folded into one line. The round button sends, or stops the turn. |
| A question | **Allow** / **Deny**, the options to tap, or **Approve** for a plan. Or type your own answer. |
| Terminal | Fitted to the phone, with **Esc**, **Tab**, arrows, **^C** and **Fit**. Whoever typed last sets its size. |
| **Views** | Installed views marked for phones, including ones that show your [widgets](../widgets/). |

A paired phone cannot open a plain terminal, edit the board, or host a frame. The first answer
counts, from the phone or the desktop.

### Who sizes a terminal

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/phone-terminal-size.svg" width="640" height="284" alt="State diagram: a terminal opened on the phone takes the phone's size. A key typed on the desktop, turning Fit off, or closing the terminal or hiding the page gives it the desktop size. A phone key while Fit is on, pressing Fit, or showing the page again gives it the phone's size again. Allow, Deny and choosing an option are not typing." /></div>
  <figcaption>Whoever typed last sets the size</figcaption>
</figure>

## The whole app in a browser tab

**Settings → In a browser → Serve the app to a browser** serves the full app at
`http://127.0.0.1:4483/#token=…`, for this computer only. The token changes each time the app
starts; anyone with the link can use your terminals.

The iOS and Android apps are development previews and not published.

---
title: Connect devices
description: Pair your phone or another computer, or let someone in, with one offer from Settings → Connect.
---

One offer from **Settings → Connect** serves your phone, another computer of yours, or another
person. You decide which when the other device uses it.

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/connect-offer.svg" width="640" height="596" alt="Flowchart: you make an offer on Settings → Connect; the other device uses it and both show three words. On your computer you answer Deny (nothing is kept), Someone else (they join the workspace at the role you pick) or It's me; then the other device asks whether the words match: Yes pairs it as you, No keeps nothing. A request left unanswered for about three minutes counts as Deny." /></div>
  <figcaption>One offer, three answers</figcaption>
</figure>

## 1. Make an offer

Open **Settings → Connect** and press **Connect**. To let a person into a workspace, do it in that
workspace's window. The offer shows a QR code, six words and **Copy the link**. It lasts a day,
until one device uses it, or until you make another.

The six words work on the same network only. From elsewhere, send the link; that needs a
[network server](../self-hosting/).

## 2. Use it on the other device

| Device | Do |
|---|---|
| Another computer | **Have a code? Join** (Home or Settings → Connect), paste the link or type the words, **Connect**. |
| A phone | Pick the **Phone browser** tab first, then scan the code: [Phone and browser](../phone/#pair). |

## 3. Answer on your computer

Both screens show three words. Answer only if they match.

| Answer | Result |
|---|---|
| **Deny** | Nothing is kept. Closing the notice, or waiting about three minutes, is the same. |
| **Someone else** + a role | That person joins this workspace at **Can view**, **Can edit board** or **Can use terminals**. |
| **It's me — the words match** | After **Yes** on the other device, it is paired as you: your workspaces are its workspaces. |

**Someone else** is not offered for a phone or for an offer made from Home. **It's me** is not
offered for a computer that already shares a workspace with someone.

## Your devices

**Connected → Your devices** lists each paired device: *Always on* (a host), *A computer*, or
*Phone or browser*. **Unpair** cuts it off from this computer. A host pairs from its own terminal:
`hive host pair` ([Always-on host](../host/)).

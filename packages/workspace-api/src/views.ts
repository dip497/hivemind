/**
 * What the workspace API says about community views on a remote screen (P8,
 * docs/design/phone-app-2026-10-02.md §6.1): a view offered there, one of its files, and the
 * screen it is shown on. What a view and its host say to each other is the view protocol's
 * (`@hivemind/view-sdk/protocol`). Node-free.
 */
import type { ViewTheme } from "@hivemind/view-sdk/protocol";

/** A view installed on the device that says it works on a phone: its id, name, version, the file
 *  it starts from, and the page a screen loads to show it (0.14): `entry` when that is a page,
 *  else `__entry.html`, which runs it. */
export interface ViewListing {
  id: string;
  name: string;
  version: string;
  entry: string;
  page: string;
}

/** One of a view's files: its bytes, base64, its type, and the Content-Security-Policy to serve it
 *  under (0.14), whose nonce a page it is carries. */
export interface ViewFile {
  data: string;
  type: string;
  csp: string;
}

/** The screen a view is shown on (0.14): its size in CSS pixels, and the look the app there gives
 *  views, as `hello`, `resize` and `theme` say them to the view. */
export interface ViewScreen {
  w: number;
  h: number;
  theme: ViewTheme;
}

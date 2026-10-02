/**
 * What the workspace API says about community views on a remote screen (P8,
 * docs/design/phone-app-2026-10-02.md §6.1): a view offered there, and one of its files. What a
 * view and its host say to each other is the view protocol's (`@hivemind/view-sdk/protocol`).
 * Node-free.
 */

/** A view installed on the device that says it works on a phone: its id, name, version, and the
 *  file it starts from. */
export interface ViewListing {
  id: string;
  name: string;
  version: string;
  entry: string;
}

/** One of a view's files: its bytes, base64, and its type. */
export interface ViewFile {
  data: string;
  type: string;
}

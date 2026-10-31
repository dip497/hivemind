/** Where a window finds a file a note keeps: on the app's media scheme, by its repo and name. */

export const PAGE_FILE_HOST = "note";

export const pageFileUrl = (repo: string, name: string): string =>
  `hivemedia://${PAGE_FILE_HOST}/${encodeURIComponent(repo)}/${encodeURIComponent(name)}`;

/** The repo and file a `pageFileUrl` names. */
export function pageFileNamed(url: string): { repo: string; name: string } {
  const [repo = "", name = ""] = new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return { repo, name };
}

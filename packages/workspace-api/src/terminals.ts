/**
 * What the workspace API says about terminals: how one is opened, and how a session ends. A
 * terminal is named by its session id (`hm:<tile>`). Node-free.
 */

export interface TerminalOpts {
  /** The session's id: `hm:<tile>`, or one of its own for a window's session in this process. */
  tileId: string;
  /** The tile it is the session of, which its id does not always say. */
  tile?: string;
  /** Where it runs: a directory on the host, or a remote one (`machine://` or `ssh://`). */
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** An agent's first task, handed to it as it starts rather than typed into it. */
  initialPrompt?: string;
  /** Show a session the host holds; never start one. */
  attachOnly?: boolean;
  /** With `attachOnly`: a running session only, not one saved before a restart. */
  liveOnly?: boolean;
}

/** How a session ended. */
export interface ExitInfo { code: number; signal?: number }

/** How busy each watched terminal's output is, 0 (quiet) to 3. Only changes are sent. */
export type ActivityLevels = Record<string, 0 | 1 | 2 | 3>;

/** Someone at a client, as the others see them: who holds a terminal's keyboard, asks for it, or
 *  types into it. */
export interface Typist {
  /** Their client's id: one per window, or per peer device. */
  id: string;
  person: string;
  name: string;
}

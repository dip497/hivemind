//! Keys by name, as `hive ctl keys` takes them (packages/agent-host/src/keys.ts): what a terminal
//! is sent for each. A raw ESC byte cannot travel as plain text, so keys go by these names; a
//! token not named here is typed as itself, so digits and words type.

use std::time::Duration;

const KEYS: [(&str, &str); 18] = [
    ("up", "\x1b[A"),
    ("down", "\x1b[B"),
    ("right", "\x1b[C"),
    ("left", "\x1b[D"),
    ("enter", "\r"),
    ("return", "\r"),
    ("esc", "\x1b"),
    ("escape", "\x1b"),
    ("tab", "\t"),
    ("space", " "),
    ("backspace", "\x7f"),
    ("del", "\x1b[3~"),
    ("delete", "\x1b[3~"),
    ("home", "\x1b[H"),
    ("end", "\x1b[F"),
    ("pageup", "\x1b[5~"),
    ("pagedown", "\x1b[6~"),
    ("ctrl-c", "\x03"),
];

/// Between two keys, so a TUI takes each one: an arrow and Enter together can miss the move.
pub const GAP: Duration = Duration::from_millis(40);

/// What a terminal is sent for `token`, a key's name in any case.
pub fn bytes(token: &str) -> &str {
    let named = token.to_lowercase();
    KEYS.iter()
        .find(|(name, _)| *name == named)
        .map_or(token, |(_, bytes)| bytes)
}

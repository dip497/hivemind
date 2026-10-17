//! Keys by name (keys.rs): the ones the phone's row of keys sends (Esc, Tab, the arrows, Enter,
//! Ctrl-C; design phone-app-2026-10-02.md §6) are the bytes a terminal takes for them, as `hive ctl
//! keys` sends them, named in any case; any other token types as itself.

use hive_phone::keys;

#[test]
fn a_key_by_name_is_the_bytes_a_terminal_takes_for_it_and_anything_else_types_as_itself() {
    let named = [
        ("escape", "\x1b"),
        ("Esc", "\x1b"),
        ("tab", "\t"),
        ("up", "\x1b[A"),
        ("down", "\x1b[B"),
        ("right", "\x1b[C"),
        ("left", "\x1b[D"),
        ("enter", "\r"),
        ("ENTER", "\r"),
        ("ctrl-c", "\x03"),
        ("y", "y"),
        ("2", "2"),
        ("ctrl-q", "ctrl-q"),
    ];
    for (token, bytes) in named {
        assert_eq!(keys::bytes(token), bytes, "{token}");
    }
}

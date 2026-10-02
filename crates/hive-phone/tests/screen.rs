//! A watched terminal's screen (screen.rs; docs/design/phone-app-2026-10-02.md §5.3): the
//! session's output gives the lines the app draws, each numbered from when the watch began and
//! sent again only once it changed, the screen and 2,000 lines of scrollback, with the cursor and
//! the session's size; each line's style runs packed 16 bytes a run, a double-width character a
//! run of its own. The same output in any pieces gives the same screen; clearing the scrollback,
//! even inside a synchronized update, leaves nothing of what was cleared; the alternate screen
//! leaves the main one as it was; a resize sends every line again. On its own thread, a screen
//! publishes a frame at most every 16 ms, the newest, and never half a synchronized update.

use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use hive_phone::screen::{Frame, LiveScreen, Screen, SCROLLBACK};

/// A run as §5.3 packs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Run {
    start: u16,
    len: u16,
    col: u16,
    flags: u16,
    fg: u32,
    bg: u32,
}

const BOLD: u16 = 1;
const WIDE: u16 = 1 << 8;

/// A run of `len` UTF-16 units from `start`, in column `col`, in the default colours.
fn plain(start: u16, len: u16, col: u16, flags: u16) -> Run {
    Run {
        start,
        len,
        col,
        flags,
        fg: 0,
        bg: 0,
    }
}

/// The runs of a line, read as the apps read them: 16 bytes each, little-endian.
fn runs(packed: &[u8]) -> Vec<Run> {
    assert_eq!(packed.len() % 16, 0, "whole runs");
    let u16_at = |r: &[u8], i: usize| u16::from_le_bytes([r[i], r[i + 1]]);
    let u32_at = |r: &[u8], i: usize| u32::from_le_bytes(r[i..i + 4].try_into().unwrap());
    packed
        .chunks(16)
        .map(|r| Run {
            start: u16_at(r, 0),
            len: u16_at(r, 2),
            col: u16_at(r, 4),
            flags: u16_at(r, 6),
            fg: u32_at(r, 8),
            bg: u32_at(r, 12),
        })
        .collect()
}

/// Every line a frame keeps: its number, its text and its runs.
fn lines(frame: &Frame) -> Vec<(u64, String, Vec<Run>)> {
    frame
        .changed(0)
        .map(|(n, line)| (n, line.text.clone(), runs(&line.runs)))
        .collect()
}

/// The lines changed since `since`: their numbers and texts.
fn changed(frame: &Frame, since: u64) -> Vec<(u64, String)> {
    frame
        .changed(since)
        .map(|(n, line)| (n, line.text.clone()))
        .collect()
}

/// What a frame says besides its lines.
fn shape(frame: &Frame) -> (u16, u16, u64, u64, u64, u16, bool) {
    (
        frame.cols,
        frame.rows,
        frame.first_line,
        frame.line_count(),
        frame.cursor_line,
        frame.cursor_col,
        frame.cursor_visible,
    )
}

fn frame_of(output: &[u8]) -> Frame {
    let mut screen = Screen::default();
    screen.feed(output);
    screen.frame().expect("a frame")
}

/// `n` numbered lines, each ended by a newline.
fn numbered(word: &str, n: std::ops::Range<usize>) -> Vec<u8> {
    n.map(|i| format!("{word} {i}\r\n"))
        .collect::<String>()
        .into_bytes()
}

#[test]
fn known_output_gives_its_lines_their_runs_the_cursor_and_the_size() {
    let frame = frame_of(b"hello \x1b[1;31mred\x1b[0m world\r\nsecond\x1b[?25l");
    assert_eq!(shape(&frame), (80, 24, 0, 24, 1, 6, false));
    let all = lines(&frame);
    assert_eq!(
        all[0],
        (
            0,
            "hello red world".into(),
            vec![
                plain(0, 6, 0, 0),
                Run {
                    fg: 0x0100_0001,
                    ..plain(6, 3, 6, BOLD)
                },
                plain(9, 6, 9, 0),
            ]
        )
    );
    assert_eq!(all[1], (1, "second".into(), vec![plain(0, 6, 0, 0)]));
    assert!(all[2..]
        .iter()
        .all(|(_, text, runs)| text.is_empty() && runs.is_empty()));
}

#[test]
fn a_double_width_character_is_a_run_of_its_own_in_the_column_it_starts_at() {
    let frame = frame_of("a漢字b😀c e\u{301}".as_bytes());
    assert_eq!(
        lines(&frame)[0],
        (
            0,
            "a漢字b😀c e\u{301}".into(),
            vec![
                plain(0, 1, 0, 0),
                plain(1, 1, 1, WIDE),
                plain(2, 1, 3, WIDE),
                plain(3, 1, 5, 0),
                // Two UTF-16 units, one character.
                plain(4, 2, 6, WIDE),
                // A combining accent rides with its letter, in its cell.
                plain(6, 4, 8, 0),
            ]
        )
    );
    // One that does not fit at the end of a line goes to the next.
    let frame = frame_of(format!("{}漢", "x".repeat(79)).as_bytes());
    assert_eq!(lines(&frame)[0].1, "x".repeat(79));
    assert_eq!(
        lines(&frame)[1],
        (1, "漢".into(), vec![plain(0, 1, 0, WIDE)])
    );
}

#[test]
fn colours_and_flags_are_packed_as_the_apps_read_them() {
    // SGR, then the run's flags, foreground and background: top byte 0 the default, 1 a palette
    // index, 2 RGB.
    let cases: [(&str, u16, u32, u32); 21] = [
        ("1", 1 << 0, 0, 0),
        ("2", 1 << 1, 0, 0),
        ("3", 1 << 2, 0, 0),
        ("4", 1 << 3, 0, 0),
        ("4:2", 1 << 3, 0, 0),
        ("4:3", 1 << 3, 0, 0),
        ("7", 1 << 4, 0, 0),
        ("9", 1 << 5, 0, 0),
        ("8", 1 << 6, 0, 0),
        ("1;3;4", 0b1101, 0, 0),
        ("31", 0, 0x0100_0001, 0),
        ("97", 0, 0x0100_000f, 0),
        ("38;5;200", 0, 0x0100_00c8, 0),
        ("38;2;10;20;30", 0, 0x020a_141e, 0),
        ("44", 0, 0, 0x0100_0004),
        ("48;5;17", 0, 0, 0x0100_0011),
        ("48;2;255;128;0", 0, 0, 0x02ff_8000),
        ("31;39", 0, 0, 0),
        ("44;49", 0, 0, 0),
        ("1;22", 0, 0, 0),
        ("7;27", 0, 0, 0),
    ];
    for (sgr, flags, fg, bg) in cases {
        let frame = frame_of(format!("\x1b[{sgr}mx").as_bytes());
        assert_eq!(
            lines(&frame)[0].2,
            vec![Run {
                fg,
                bg,
                ..plain(0, 1, 0, flags)
            }],
            "SGR {sgr}"
        );
    }
    // Spaces at the end of a line are left out, unless they draw: on a colour, inverse, underlined.
    assert_eq!(lines(&frame_of(b"ab   "))[0].1, "ab");
    for (sgr, drawn) in [("44", 0x0100_0004), ("7", 0), ("4", 0)] {
        let frame = frame_of(format!("ab\x1b[{sgr}m  \x1b[0m").as_bytes());
        assert_eq!(lines(&frame)[0].1, "ab  ", "SGR {sgr}");
        assert_eq!(lines(&frame)[0].2[1].bg, drawn, "SGR {sgr}");
    }
}

/// Output of every kind: colours, wide characters, scrolling, a clear inside a synchronized
/// update, the alternate screen and back, the cursor moved and hidden.
fn varied() -> Vec<u8> {
    let mut out = vec![];
    for i in 0..60 {
        out.extend(format!("\x1b[3{}mline {i} 漢字 e\u{301}\x1b[0m\r\n", i % 8).as_bytes());
    }
    out.extend(b"\x1b[?2026h\x1b[2J\x1b[3J\x1b[H");
    out.extend(numbered("again", 0..30));
    out.extend(b"\x1b[?2026l\x1b[?1049h\x1b[Halternate\x1b[?1049l");
    out.extend("\x1b[5;10Hmoved\x1b[?25ltail 😀".as_bytes());
    out
}

#[test]
fn the_same_output_in_any_pieces_gives_the_same_screen() {
    let whole = frame_of(&varied());
    for size in [1, 2, 3, 5, 8, 13, 64] {
        let mut screen = Screen::default();
        for piece in varied().chunks(size) {
            screen.feed(piece);
        }
        let pieces = screen.frame().expect("a frame");
        assert_eq!(lines(&pieces), lines(&whole), "in pieces of {size}");
        assert_eq!(shape(&pieces), shape(&whole), "in pieces of {size}");
    }
}

#[test]
fn what_changed_since_a_revision_is_the_lines_that_changed_and_no_others() {
    let mut screen = Screen::default();
    screen.feed(b"one\r\ntwo\r\nthree");
    let first = screen.frame().expect("a frame");
    screen.feed(b"\x1b[2;1Hdeux");
    let second = screen.frame().expect("a frame");
    assert_eq!(changed(&second, first.revision), [(1, "deux".into())]);
    // Nothing changed: no frame.
    assert!(screen.frame().is_none());
    let kept = (second.line_count() - second.first_line) as usize;
    assert_eq!(second.changed(0).count(), kept);
    assert_eq!(second.changed(second.revision).count(), 0);
    // A revision this screen never made: every line.
    assert_eq!(second.changed(second.revision + 1).count(), kept);
}

#[test]
fn a_line_that_scrolls_into_the_scrollback_keeps_its_number_and_is_not_sent_again() {
    let mut screen = Screen::default();
    screen.feed(&numbered("line", 0..24));
    let first = screen.frame().expect("a frame");
    assert_eq!((first.first_line, first.line_count()), (0, 25));
    screen.feed(&numbered("line", 24..25));
    let second = screen.frame().expect("a frame");
    assert_eq!((second.first_line, second.line_count()), (0, 26));
    assert_eq!(
        changed(&second, first.revision),
        [(24, "line 24".into()), (25, String::new())]
    );
    assert_eq!(changed(&second, 0)[0], (0, "line 0".into()));
}

#[test]
fn past_two_thousand_lines_of_scrollback_the_oldest_go_and_the_first_line_moves_on() {
    let mut screen = Screen::default();
    screen.feed(&numbered("line", 0..2_100));
    let first = screen.frame().expect("a frame");
    assert_eq!(first.line_count(), 2_101);
    assert_eq!(first.first_line, 2_101 - 24 - SCROLLBACK as u64);
    screen.feed(&numbered("line", 2_100..3_000));
    let second = screen.frame().expect("a frame");
    assert_eq!(second.line_count(), 3_001);
    assert_eq!(second.first_line, 3_001 - 24 - SCROLLBACK as u64);
    // Every line kept is the line its number says.
    for (n, line) in second.changed(0).filter(|(n, _)| *n < 3_000) {
        assert_eq!(line.text, format!("line {n}"));
    }
    // What is sent again begins where the first frame's lines end: none of those kept changed.
    let since = changed(&second, first.revision);
    assert_eq!(since[0], (2_100, "line 2100".into()));
    assert_eq!(since.len() as u64, second.line_count() - 2_100);
}

#[test]
fn clearing_the_scrollback_leaves_nothing_of_what_was_cleared_even_inside_a_synchronized_update() {
    let mut screen = Screen::default();
    screen.feed(&numbered("old", 0..40));
    let before = screen.frame().expect("a frame");
    // `clear`, as ncurses writes it.
    screen.feed(b"\x1b[H\x1b[2J\x1b[3Jnew\r\n");
    let cleared = screen.frame().expect("a frame");
    assert_eq!(cleared.line_count() - cleared.first_line, 24);
    assert!(cleared.first_line >= before.line_count() - 24);
    assert_eq!(lines(&cleared)[0].1, "new");
    // As Claude Code redraws, over a scrollback: a clear, then its whole transcript again, in one
    // synchronized update, written at once.
    screen.feed(&numbered("old", 0..40));
    let mut redraw = b"\x1b[?2026h\x1b[2J\x1b[3J\x1b[H".to_vec();
    redraw.extend(numbered("again", 0..60));
    redraw.extend(b"\x1b[?2026l");
    screen.feed(&redraw);
    let redrawn = screen.frame().expect("a frame");
    let texts: Vec<String> = lines(&redrawn)
        .into_iter()
        .map(|(_, text, _)| text)
        .collect();
    let expected: Vec<String> = (0..60)
        .map(|i| format!("again {i}"))
        .chain([String::new()])
        .collect();
    assert_eq!(texts, expected);
    assert!(redrawn.first_line >= cleared.first_line);
}

#[test]
fn the_alternate_screen_leaves_the_main_one_and_its_scrollback_as_they_were() {
    let mut screen = Screen::default();
    screen.feed(&numbered("main", 0..30));
    let main = screen.frame().expect("a frame");
    // Lines scrolled just before it begins are kept too.
    screen.feed(&numbered("main", 30..32));
    screen.feed(b"\x1b[?1049h\x1b[Hfull screen");
    let alternate = screen.frame().expect("a frame");
    assert_eq!(alternate.first_line, main.first_line);
    assert_eq!(alternate.line_count(), main.line_count() + 2);
    let top = alternate.line_count() - 24;
    assert_eq!(
        changed(&alternate, 0)[top as usize],
        (top, "full screen".into())
    );
    assert_eq!(changed(&alternate, 0)[0], (0, "main 0".into()));
    screen.feed(b"\x1b[?1049l");
    let back = screen.frame().expect("a frame");
    // As if it had never shown, the cursor where it was.
    let never = frame_of(&numbered("main", 0..32));
    assert_eq!(lines(&back), lines(&never));
    assert_eq!(shape(&back), shape(&never));
}

#[test]
fn a_resize_sends_every_line_again_at_the_new_size_on_either_screen() {
    let mut screen = Screen::default();
    screen.feed(&numbered("line", 0..30));
    let before = screen.frame().expect("a frame");
    screen.resize(100, 30);
    let after = screen.frame().expect("a frame");
    assert_eq!((after.cols, after.rows), (100, 30));
    let kept = (after.line_count() - after.first_line) as usize;
    assert_eq!(after.changed(before.revision).count(), kept);
    assert_eq!(changed(&after, before.revision)[0], (0, "line 0".into()));
    // On the alternate screen, and the main one read again once it shows.
    screen.feed(b"\x1b[?1049h\x1b[Hfull screen");
    let alternate = screen.frame().expect("a frame");
    screen.resize(60, 20);
    let resized = screen.frame().expect("a frame");
    assert_eq!((resized.cols, resized.rows), (60, 20));
    let kept = (resized.line_count() - resized.first_line) as usize;
    assert_eq!(resized.changed(alternate.revision).count(), kept);
    screen.feed(b"\x1b[?1049l");
    let back = screen.frame().expect("a frame");
    let kept = (back.line_count() - back.first_line) as usize;
    assert_eq!(back.changed(resized.revision).count(), kept);
    assert!(changed(&back, 0).iter().any(|(_, text)| text == "line 29"));
}

/// The frames a live screen told of: when, and their revisions.
type Told = Arc<Mutex<Vec<(Instant, u64)>>>;

/// What a live screen tells of its frames, and what it is told with.
fn told() -> (Told, impl Fn(u64) + Send + 'static) {
    let told = Arc::new(Mutex::new(vec![]));
    let tell = told.clone();
    (told, move |revision| {
        tell.lock().unwrap().push((Instant::now(), revision))
    })
}

#[test]
fn on_its_own_thread_a_screen_publishes_at_most_a_frame_every_16_ms_the_newest() {
    let (told, tell) = told();
    let live = LiveScreen::start(tell);
    let began = Instant::now();
    for i in 0..2_000 {
        live.output(format!("line {i}\r\n").as_bytes());
    }
    // The last of it shows within a frame or so of its coming.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !live
        .newest()
        .changed(0)
        .any(|(_, line)| line.text == "line 1999")
    {
        assert!(Instant::now() < deadline, "the last line never showed");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(50));
    let told = told.lock().unwrap().clone();
    let took = told.last().unwrap().0 - began;
    assert!(
        told.len() as u128 <= took.as_millis() / 16 + 2,
        "{} frames in {took:?}",
        told.len()
    );
    for pair in told.windows(2) {
        assert!(pair[1].0 - pair[0].0 >= Duration::from_millis(15));
        assert!(pair[1].1 > pair[0].1);
    }
    assert_eq!(told.last().unwrap().1, live.newest().revision);
}

#[test]
fn a_frame_never_shows_half_a_synchronized_update() {
    let (told, tell) = told();
    let live = LiveScreen::start(tell);
    live.output(b"\x1b[?2026hhalf");
    thread::sleep(Duration::from_millis(80));
    assert!(told.lock().unwrap().is_empty());
    assert!(live
        .newest()
        .changed(0)
        .all(|(_, line)| line.text.is_empty()));
    live.output(b" done\x1b[?2026l");
    let deadline = Instant::now() + Duration::from_secs(5);
    while told.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "no frame after the update ended");
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(lines(&live.newest())[0].1, "half done");
    // One never ended lapses: what it held shows.
    live.output(b"\x1b[?2026h\r\nnever ended");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !live
        .newest()
        .changed(0)
        .any(|(_, line)| line.text == "never ended")
    {
        assert!(Instant::now() < deadline, "a lapsed update never showed");
        thread::sleep(Duration::from_millis(5));
    }
}

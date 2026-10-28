//! A watched terminal's screen (docs/design/phone-app-2026-10-02.md §5.3): the session's bytes run
//! through a VT emulator (alacritty's, as Zed's), and its lines kept as the phone draws them, the
//! screen and 2,000 lines of scrollback. Each line is numbered from when the watch began, so its
//! number names the same line as it scrolls into the scrollback, and stamped with the revision it
//! last changed at, so the app asks only for what changed since the frame it last drew: its text,
//! with its style runs packed as bytes, never a call per cell.

use std::{collections::VecDeque, sync::Arc, time::Duration};

#[cfg(target_family = "wasm")]
use n0_future::time::Instant;
#[cfg(not(target_family = "wasm"))]
use std::time::Instant;

use alacritty_terminal::{
    event::VoidListener,
    grid::{Dimensions, Row},
    index::{self, Column},
    term::{
        cell::{Cell, Flags},
        Config, Term, TermMode,
    },
    vte::ansi::{Color, Processor, Timeout},
};

#[cfg(not(target_family = "wasm"))]
mod live;
#[cfg(not(target_family = "wasm"))]
pub use live::LiveScreen;

/// Lines of scrollback kept.
pub const SCROLLBACK: usize = 2_000;
/// Lines of scrollback a page asks for as it begins to watch: more as the person scrolls to them.
pub const FIRST_HISTORY: usize = 200;
/// A watch's size until the session says its own (`terminal.size`).
const FIRST_SIZE: (u16, u16) = (80, 24);
/// The largest size taken: no terminal is bigger, and a bigger one would be a phone's memory.
const LARGEST: (u16, u16) = (1_000, 1_000);
/// What the emulator is given at a time. A piece scrolls a line a byte at most (but for a
/// `CSI n S`), so with the emulator's scrollback this much over what is kept, every line that
/// scrolled is counted, and numbered.
const PIECE: usize = 4_096;
/// How long a synchronized update holds the frame back at most, as alacritty.
const SYNC_LAPSES: Duration = Duration::from_millis(150);

/// The sequences told apart before the emulator sees them: a synchronized update begun and ended
/// (DEC mode 2026), which hold back the frame, never the emulator; and the two that take the
/// scrollback away (a reset, `ED 3`), the lines that scrolled before each counted first.
const BEGIN_SYNC: &[u8] = b"\x1b[?2026h";
const END_SYNC: &[u8] = b"\x1b[?2026l";
const RESET: &[u8] = b"\x1bc";
const CLEAR_SCROLLBACK: &[u8] = b"\x1b[3J";
const TOLD_APART: [&[u8]; 4] = [BEGIN_SYNC, END_SYNC, RESET, CLEAR_SCROLLBACK];

/// A run's flags, by the bit each is (§5.3).
const STYLES: [(Flags, u16); 7] = [
    (Flags::BOLD, 1 << 0),
    (Flags::DIM, 1 << 1),
    (Flags::ITALIC, 1 << 2),
    (Flags::ALL_UNDERLINES, 1 << 3),
    (Flags::INVERSE, 1 << 4),
    (Flags::STRIKEOUT, 1 << 5),
    (Flags::HIDDEN, 1 << 6),
];
/// A run of one double-width character.
const WIDE: u16 = 1 << 8;

/// A line as the app draws it.
#[derive(Debug)]
pub struct Line {
    pub text: String,
    /// Its style runs, 16 bytes each (§5.3).
    pub runs: Vec<u8>,
    /// The revision it last changed at.
    revision: u64,
}

/// The screen at a revision, as the app is handed it: never changed once made.
#[derive(Debug)]
pub struct Frame {
    pub revision: u64,
    /// The session's size.
    pub cols: u16,
    pub rows: u16,
    /// The oldest line kept.
    pub first_line: u64,
    pub cursor_line: u64,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    /// Where the person's scrolling goes: the view's own scrollback, or the program.
    pub wheel: Wheel,
    lines: Vec<Arc<Line>>,
}

impl Frame {
    /// One past the newest line.
    pub fn line_count(&self) -> u64 {
        self.first_line + self.lines.len() as u64
    }

    /// The lines changed since `since`, the revision the app last drew, oldest first, each with
    /// its number: every line kept when `since` is 0, or a revision this screen never made.
    pub fn changed(&self, since: u64) -> impl Iterator<Item = (u64, &Line)> {
        let all = since == 0 || since > self.revision;
        (self.first_line..)
            .zip(self.lines.iter().map(Arc::as_ref))
            .filter(move |(_, line)| all || line.revision > since)
    }
}

/// The lines kept, oldest first: `history` lines of scrollback, then the screen's.
struct Lines {
    kept: VecDeque<Arc<Line>>,
    /// The number of the oldest.
    first: u64,
    history: usize,
    /// The revision the next frame is: what changes now is stamped with it.
    revision: u64,
    /// Whether anything shown changed since the last frame.
    changed: bool,
}

impl Lines {
    /// Keep `text` and `runs` as the line at `at`, stamped anew only when it changed.
    fn put(&mut self, at: usize, text: String, runs: Vec<u8>) {
        if self
            .kept
            .get(at)
            .is_some_and(|line| line.text == text && line.runs == runs)
        {
            return;
        }
        let line = Arc::new(Line {
            text,
            runs,
            revision: self.revision,
        });
        match self.kept.get_mut(at) {
            Some(kept) => *kept = line,
            None => self.kept.push_back(line),
        }
        self.changed = true;
    }

    /// The scrollback was taken away: the screen's lines keep their numbers.
    fn forget_history(&mut self) {
        self.kept.drain(..self.history);
        self.first += self.history as u64;
        self.history = 0;
        self.changed = true;
    }
}

/// A terminal's screen, fed its session's output as it comes.
pub struct Screen {
    term: Term<VoidListener>,
    parser: Processor<Begun>,
    /// The start of a sequence told apart, cut off at the end of what came: the rest comes next.
    carry: Vec<u8>,
    /// Since a synchronized update began, when it lapses.
    sync: Option<Instant>,
    lines: Lines,
    /// Whether the alternate screen showed when the scrollback was last counted: it keeps none,
    /// and the main screen's waits as it was.
    alternate: bool,
    /// Resized while the alternate screen showed: the main one is read whole once it shows again.
    reread: bool,
    /// The cursor as the last frame showed it: its line, its column, whether it shows.
    cursor: Option<(u64, u16, bool)>,
    /// Where scrolling went, as the last frame said.
    wheel: Wheel,
    /// The lines of scrollback last asked of the session's host.
    asked: usize,
}

impl Default for Screen {
    fn default() -> Self {
        let config = Config {
            scrolling_history: SCROLLBACK + PIECE,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &Size(FIRST_SIZE.0, FIRST_SIZE.1), VoidListener),
            parser: Processor::new(),
            carry: vec![],
            sync: None,
            lines: Lines {
                kept: VecDeque::new(),
                first: 0,
                history: 0,
                revision: 1,
                changed: true,
            },
            alternate: false,
            reread: false,
            cursor: None,
            wheel: Wheel::Scrollback,
            asked: FIRST_HISTORY,
        }
    }
}

impl Screen {
    /// Take more of the session's output.
    pub fn feed(&mut self, bytes: &[u8]) {
        let joined;
        let input = if self.carry.is_empty() {
            bytes
        } else {
            let mut carried = std::mem::take(&mut self.carry);
            carried.extend_from_slice(bytes);
            joined = carried;
            &joined[..]
        };
        let (mut from, mut at) = (0, 0);
        while let Some(esc) = input[at..].iter().position(|&b| b == 0x1b).map(|i| at + i) {
            let rest = &input[esc..];
            if let Some(told) = TOLD_APART.iter().find(|s| rest.starts_with(s)) {
                self.emulate(&input[from..esc]);
                self.told(told);
                (from, at) = (esc + told.len(), esc + told.len());
            } else if TOLD_APART.iter().any(|s| s.starts_with(rest)) {
                self.emulate(&input[from..esc]);
                self.carry = rest.to_vec();
                return;
            } else {
                at = esc + 1;
            }
        }
        self.emulate(&input[from..]);
    }

    /// The session's screen sent again whole, as each connection that shows it is sent it: drawn
    /// in place of what was shown, from a reset, with the scrollback a page asks for on joining.
    pub fn redraw(&mut self, bytes: &[u8]) {
        self.asked = FIRST_HISTORY;
        self.feed(RESET);
        self.feed(bytes);
    }

    /// The person scrolled to the oldest line kept: how many lines of scrollback to ask the host
    /// for now. None while it holds less than it last asked for (the host has no more, or has not
    /// answered yet), or all it keeps.
    pub fn earlier(&mut self) -> Option<usize> {
        let held = self.lines.history;
        if held < self.asked || held >= SCROLLBACK {
            return None;
        }
        self.asked = (held * 4).min(SCROLLBACK);
        Some(self.asked)
    }

    /// The session took a size (`terminal.size`): every line is new to the app.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = Size(cols.clamp(1, LARGEST.0), rows.clamp(1, LARGEST.1));
        if (size.columns(), size.screen_lines()) == (self.term.columns(), self.term.screen_lines())
        {
            return;
        }
        self.account();
        self.term.resize(size);
        if !self.term.mode().contains(TermMode::ALT_SCREEN) {
            return self.read_whole();
        }
        // The main screen, rewrapped, is read once it shows again; meanwhile its scrollback is
        // shown as it was, anew.
        self.reread = true;
        let lines = &mut self.lines;
        for line in lines.kept.iter_mut() {
            *line = Arc::new(Line {
                text: line.text.clone(),
                runs: line.runs.clone(),
                revision: lines.revision,
            });
        }
        lines.changed = true;
    }

    /// What the program is sent for the person scrolling `lines` (up, to earlier, below 0) at the
    /// cell `col`, `row` (from 1); none when the view scrolls its own scrollback, so 0 lines asks
    /// whose a scroll is.
    pub fn scroll(&self, lines: i32, col: u16, row: u16) -> Option<String> {
        Wheel::of(*self.term.mode()).keys(lines, col, row)
    }

    /// What the program is sent for a tap at the cell `col`, `row` (from 1): a left press and
    /// release, when it takes the mouse; none when it does not.
    pub fn click(&self, col: u16, row: u16) -> Option<String> {
        Wheel::of(*self.term.mode()).click(col, row)
    }

    /// While a synchronized update is open: when it lapses, the frame held back until then.
    pub fn held(&self) -> Option<Instant> {
        self.sync
    }

    /// The screen as it is now, when anything it shows changed since the last one.
    pub fn frame(&mut self) -> Option<Frame> {
        self.account();
        let grid = self.term.grid();
        let (cols, rows) = (grid.columns(), grid.screen_lines());
        let lines = &mut self.lines;
        for row in 0..rows {
            let (text, runs) = encode(&grid[index::Line(row as i32)], cols);
            lines.put(lines.history + row, text, runs);
        }
        lines.changed |= lines.kept.len() > lines.history + rows;
        lines.kept.truncate(lines.history + rows);
        let point = grid.cursor.point;
        let cursor = (
            lines.first + (lines.history + point.line.0 as usize) as u64,
            point.column.0 as u16,
            self.term.mode().contains(TermMode::SHOW_CURSOR),
        );
        let wheel = Wheel::of(*self.term.mode());
        if !lines.changed && self.cursor == Some(cursor) && self.wheel == wheel {
            return None;
        }
        let frame = Frame {
            revision: lines.revision,
            cols: cols as u16,
            rows: rows as u16,
            first_line: lines.first,
            cursor_line: cursor.0,
            cursor_col: cursor.1,
            cursor_visible: cursor.2,
            wheel,
            lines: lines.kept.iter().cloned().collect(),
        };
        lines.revision += 1;
        lines.changed = false;
        self.cursor = Some(cursor);
        self.wheel = wheel;
        Some(frame)
    }

    /// Run `bytes` through the emulator, a piece at a time, counting what scrolls out of each.
    fn emulate(&mut self, bytes: &[u8]) {
        for piece in bytes.chunks(PIECE) {
            self.parser.advance(&mut self.term, piece);
            // A synchronized update begun some other way than told apart: what it holds goes
            // through at once, so nothing waits on a lapse no one keeps.
            if self.parser.sync_timeout().pending_timeout() {
                self.parser.stop_sync(&mut self.term);
            }
            self.account();
        }
    }

    /// One of the sequences told apart.
    fn told(&mut self, sequence: &[u8]) {
        match sequence {
            BEGIN_SYNC => self.sync = Some(Instant::now() + SYNC_LAPSES),
            END_SYNC => self.sync = None,
            _ => {
                self.account();
                self.parser.advance(&mut self.term, sequence);
                self.account();
            }
        }
    }

    /// Keep the lines that scrolled into the scrollback since it was last counted, each with its
    /// number, and no more than 2,000 of them.
    fn account(&mut self) {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            self.alternate = true;
            return;
        }
        if std::mem::take(&mut self.alternate) && std::mem::take(&mut self.reread) {
            return self.read_whole();
        }
        let grid = self.term.grid();
        let now = grid.history_size();
        let lines = &mut self.lines;
        if now < lines.history {
            lines.forget_history();
        }
        if now == lines.history {
            return;
        }
        let keep = now.min(SCROLLBACK);
        let end = lines.first + now as u64;
        let first = end - keep as u64;
        let gone = ((first - lines.first) as usize).min(lines.kept.len());
        lines.kept.drain(..gone);
        lines.changed |= gone > 0;
        let from = (lines.first + lines.history as u64).max(first);
        (lines.first, lines.history) = (first, keep);
        for at in from..end {
            let (text, runs) = encode(&grid[index::Line(-((end - at) as i32))], grid.columns());
            lines.put((at - first) as usize, text, runs);
        }
        self.trim_emulator(now);
    }

    /// Read the main screen's scrollback whole, its lines numbered on from the oldest kept, every
    /// one of them new to the app; the screen's own are read with the frame.
    fn read_whole(&mut self) {
        let grid = self.term.grid();
        let now = grid.history_size();
        let keep = now.min(SCROLLBACK);
        let lines = &mut self.lines;
        lines.kept.clear();
        lines.history = keep;
        lines.changed = true;
        for back in (1..=keep).rev() {
            let (text, runs) = encode(&grid[index::Line(-(back as i32))], grid.columns());
            lines.put(keep - back, text, runs);
        }
        self.trim_emulator(now);
    }

    /// The emulator keeps what is kept here, and room for a piece's scrolling over it.
    fn trim_emulator(&mut self, history: usize) {
        if history > SCROLLBACK {
            let grid = self.term.grid_mut();
            grid.update_history(SCROLLBACK);
            grid.update_history(SCROLLBACK + PIECE);
        }
    }
}

/// A synchronized update the emulator began itself, which `emulate` ends at once: no clock, which
/// a browser's wasm has none of where the emulator would read it.
#[derive(Default)]
struct Begun(bool);

impl Timeout for Begun {
    fn set_timeout(&mut self, _: Duration) {
        self.0 = true;
    }

    fn clear_timeout(&mut self) {
        self.0 = false;
    }

    fn pending_timeout(&self) -> bool {
        self.0
    }
}

/// A size, as the emulator takes it: columns, rows.
struct Size(u16, u16);

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        self.1 as usize
    }

    fn columns(&self) -> usize {
        self.0 as usize
    }
}

/// How a run looks.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Style {
    flags: u16,
    fg: u32,
    bg: u32,
}

/// A row's text and its style runs, packed as §5.3 says: 16 bytes a run, little-endian, its
/// `start` and `len` in UTF-16 units of the text, the column it starts at, its flags and colours.
/// Blank cells at its end draw nothing and are left out; a double-width character is a run of
/// its own, so the app places each run at its column and never measures text.
fn encode(row: &Row<Cell>, cols: usize) -> (String, Vec<u8>) {
    let end = (0..cols)
        .rev()
        .find(|&col| !blank(&row[Column(col)]))
        .map_or(0, |col| col + 1);
    let (mut text, mut runs) = (String::new(), vec![]);
    let mut units = 0;
    let mut open: Option<(usize, usize, Style)> = None;
    for col in 0..end {
        let cell = &row[Column(col)];
        // The second half of a double-width character: drawn with its first.
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let wide = cell.flags.contains(Flags::WIDE_CHAR);
        let flags = STYLES
            .iter()
            .filter(|(f, _)| cell.flags.intersects(*f))
            .fold(if wide { WIDE } else { 0 }, |bits, (_, bit)| bits | bit);
        let style = Style {
            flags,
            fg: colour(cell.fg),
            bg: colour(cell.bg),
        };
        if wide || open.is_none_or(|(_, _, s)| s != style) {
            if let Some(run) = open.take() {
                pack(&mut runs, run, units);
            }
            open = Some((units, col, style));
        }
        // Where a double-width character did not fit at the end of the line, a space.
        let c = if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
            ' '
        } else {
            cell.c
        };
        for c in std::iter::once(c).chain(cell.zerowidth().into_iter().flatten().copied()) {
            text.push(c);
            units += c.len_utf16();
        }
    }
    if let Some(run) = open {
        pack(&mut runs, run, units);
    }
    (text, runs)
}

/// A run that began at `start` (UTF-16 units) in column `col` and ends at `end`, packed.
fn pack(runs: &mut Vec<u8>, (start, col, style): (usize, usize, Style), end: usize) {
    for half in [start, end - start, col, style.flags.into()] {
        runs.extend(u16::try_from(half).unwrap_or(u16::MAX).to_le_bytes());
    }
    runs.extend(style.fg.to_le_bytes());
    runs.extend(style.bg.to_le_bytes());
}

/// A cell that draws nothing: a space on the default background, nothing drawn over it.
fn blank(cell: &Cell) -> bool {
    cell.c == ' '
        && colour(cell.bg) == 0
        && !cell
            .flags
            .intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        && cell.zerowidth().is_none()
}

/// A colour as §5.3 packs it: top byte 0, the default; 1, a palette index in the low byte; 2, RGB
/// in the low three.
fn colour(color: Color) -> u32 {
    match color {
        Color::Named(named) if (named as u32) < 16 => 1 << 24 | named as u32,
        Color::Named(_) => 0,
        Color::Indexed(index) => 1 << 24 | u32::from(index),
        Color::Spec(rgb) => {
            2 << 24 | u32::from(rgb.r) << 16 | u32::from(rgb.g) << 8 | u32::from(rgb.b)
        }
    }
}

/// Where the person's scrolling goes, as the program's terminal modes say: the view's own
/// scrollback, or the program, as mouse wheel reports or (on the alternate screen) arrow keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wheel {
    Scrollback,
    Mouse { sgr: bool, utf8: bool },
    Arrows { app_cursor: bool },
}

impl Wheel {
    fn of(mode: TermMode) -> Self {
        if mode.intersects(TermMode::MOUSE_MODE) {
            Self::Mouse {
                sgr: mode.contains(TermMode::SGR_MOUSE),
                utf8: mode.contains(TermMode::UTF8_MOUSE),
            }
        } else if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
            Self::Arrows {
                app_cursor: mode.contains(TermMode::APP_CURSOR),
            }
        } else {
            Self::Scrollback
        }
    }

    /// A left press and release at the cell `col`, `row` (from 1), when the program takes the mouse.
    pub fn click(self, col: u16, row: u16) -> Option<String> {
        let Self::Mouse { sgr, utf8 } = self else {
            return None;
        };
        Some(if sgr {
            format!("\x1b[<0;{col};{row}M\x1b[<0;{col};{row}m")
        } else {
            // The old way has no release of its own button: a release is button 3.
            let report = |button: u8| Self::old_report(button, col, row, utf8);
            format!("{}{}", report(0), report(3))
        })
    }

    /// A mouse report the old way: each a character past 32, one byte or in UTF-8 two at most.
    fn old_report(button: u8, col: u16, row: u16, utf8: bool) -> String {
        let most = if utf8 { 2_015 } else { 95 };
        let at = |n: u16| char::from_u32(32 + u32::from(n.clamp(1, most))).unwrap_or(' ');
        format!("\x1b[M{}{}{}", char::from(32 + button), at(col), at(row))
    }

    /// What the program is sent for scrolling `lines` (up, to earlier, below 0) at the cell `col`,
    /// `row` (from 1); none when the view scrolls its own scrollback.
    pub fn keys(self, lines: i32, col: u16, row: u16) -> Option<String> {
        let up = lines < 0;
        let one = match self {
            Self::Scrollback => return None,
            Self::Mouse { sgr, utf8 } => {
                let button = if up { 64 } else { 65 };
                if sgr {
                    format!("\x1b[<{button};{col};{row}M")
                } else {
                    Self::old_report(button, col, row, utf8)
                }
            }
            Self::Arrows { app_cursor } => {
                let key = if up { 'A' } else { 'B' };
                let lead = if app_cursor { "\x1bO" } else { "\x1b[" };
                format!("{lead}{key}")
            }
        };
        Some(one.repeat(lines.unsigned_abs() as usize))
    }
}

//! What an agent says, which is markdown, read once here for every app (spec/markdown.md): its
//! blocks in order, each with how deep in lists and quotes it sits, and its text as runs of one
//! style each. GitHub's tables, strikethrough and task lists are read; raw HTML is not, it stays
//! text; a link is one only to an https address, written or bare, anything else stays text.

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};

/// Text of one style. A link's address is https, and nothing else.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    #[serde(default, skip_serializing_if = "not")]
    pub strong: bool,
    #[serde(default, skip_serializing_if = "not")]
    pub emphasis: bool,
    #[serde(default, skip_serializing_if = "not")]
    pub strike: bool,
    #[serde(default, skip_serializing_if = "not")]
    pub code: bool,
    /// An image, shown by its words: its address is only ever opened when tapped.
    #[serde(default, skip_serializing_if = "not")]
    pub image: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

fn not(b: &bool) -> bool {
    !*b
}

fn zero(n: &u32) -> bool {
    *n == 0
}

/// A table column's alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    None,
    Left,
    Center,
    Right,
}

/// What starts a list's item: drawn on its first block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "is", rename_all = "camelCase")]
pub enum Marker {
    Bullet,
    Number { n: u64 },
    Task { done: bool },
}

/// What a block is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "is", rename_all = "camelCase")]
pub enum Is {
    Paragraph {
        runs: Vec<Run>,
    },
    Heading {
        level: u8,
        runs: Vec<Run>,
    },
    /// As written; `language` the first word its fence names.
    Code {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        text: String,
    },
    Rule,
    /// Its head row's cells, then each row's, a cell a run list.
    Table {
        align: Vec<Align>,
        head: Vec<Vec<Run>>,
        rows: Vec<Vec<Vec<Run>>>,
    },
}

/// One block: what it is, inside how many lists (`depth`) and quotes (`quote`), the marker of the
/// list item it starts, when it starts one, and whether it runs right to left.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    #[serde(flatten)]
    pub is: Is,
    #[serde(default, skip_serializing_if = "zero")]
    pub depth: u32,
    #[serde(default, skip_serializing_if = "zero")]
    pub quote: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<Marker>,
    /// A paragraph or heading whose first letter is written right to left.
    #[serde(default, skip_serializing_if = "not")]
    pub rtl: bool,
}

/// `text`'s blocks, in order. A fence not closed yet is code to the end: the agent is still saying it.
pub fn read(text: &str) -> Vec<Block> {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut r = Reader::default();
    for event in Parser::new_ext(text, options) {
        r.event(event);
    }
    r.leaf_ends();
    r.out
}

/// `url` when it is an https address, which alone may be opened.
pub fn https(url: &str) -> Option<String> {
    let rest = url
        .get(..8)
        .filter(|s| s.eq_ignore_ascii_case("https://"))
        .map(|_| &url[8..])?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    (!host.is_empty() && !url.chars().any(|c| c.is_whitespace() || c.is_control()))
        .then(|| url.to_string())
}

#[derive(Default, Clone, Copy)]
struct Style {
    strong: u32,
    emphasis: u32,
    strike: u32,
}

/// A list's next number, none when it is not numbered.
type List = Option<u64>;

struct Table {
    align: Vec<Align>,
    head: Vec<Vec<Run>>,
    rows: Vec<Vec<Vec<Run>>>,
    in_head: bool,
}

enum Leaf {
    Paragraph,
    /// A block of raw HTML: a paragraph of its text, without its last line break.
    Html,
    Heading(u8),
    Code(Option<String>, String),
}

#[derive(Default)]
struct Reader {
    out: Vec<Block>,
    leaf: Option<Leaf>,
    runs: Vec<Run>,
    quote: u32,
    lists: Vec<List>,
    marker: Option<Marker>,
    style: Style,
    /// Inside a link: its address when it is one that may be opened.
    link: Option<Option<String>>,
    /// Inside an image: its address, as `link`.
    image: Option<Option<String>>,
    image_words: String,
    table: Option<Table>,
}

impl Reader {
    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => self.push(&t, false),
            Event::Code(t) => self.push(&t, true),
            // Raw HTML is text, as written.
            Event::Html(t)
            | Event::InlineHtml(t)
            | Event::InlineMath(t)
            | Event::DisplayMath(t) => self.push(&t, false),
            Event::SoftBreak | Event::HardBreak => self.push("\n", false),
            Event::Rule => {
                self.leaf_ends();
                self.block(Is::Rule);
            }
            Event::TaskListMarker(done) => self.marker = Some(Marker::Task { done }),
            Event::FootnoteReference(t) => self.push(&format!("[^{t}]"), false),
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => self.leaf_starts(Leaf::Paragraph),
            Tag::HtmlBlock => self.leaf_starts(Leaf::Html),
            Tag::Heading { level, .. } => self.leaf_starts(Leaf::Heading(level_of(level))),
            Tag::CodeBlock(kind) => {
                let language = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().map(str::to_string)
                    }
                    CodeBlockKind::Indented => None,
                };
                self.leaf_starts(Leaf::Code(language, String::new()));
            }
            Tag::BlockQuote(_) => {
                self.leaf_ends();
                self.quote += 1;
            }
            Tag::List(start) => {
                self.leaf_ends();
                self.lists.push(start);
            }
            Tag::Item => {
                self.leaf_ends();
                let marker = match self.lists.last_mut() {
                    Some(Some(n)) => {
                        *n += 1;
                        Marker::Number { n: *n - 1 }
                    }
                    _ => Marker::Bullet,
                };
                self.marker = Some(marker);
            }
            Tag::Table(align) => {
                self.leaf_ends();
                self.table = Some(Table {
                    align: align.into_iter().map(align_of).collect(),
                    head: Vec::new(),
                    rows: Vec::new(),
                    in_head: false,
                });
            }
            Tag::TableHead => {
                if let Some(t) = &mut self.table {
                    t.in_head = true;
                }
            }
            Tag::TableRow => {
                if let Some(t) = &mut self.table {
                    t.rows.push(Vec::new());
                }
            }
            Tag::TableCell => self.runs.clear(),
            Tag::Emphasis => self.style.emphasis += 1,
            Tag::Strong => self.style.strong += 1,
            Tag::Strikethrough => self.style.strike += 1,
            Tag::Link { dest_url, .. } => self.link = Some(https(&dest_url)),
            Tag::Image { dest_url, .. } => self.image = Some(https(&dest_url)),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock | TagEnd::HtmlBlock => {
                self.leaf_ends()
            }
            TagEnd::BlockQuote(_) => {
                self.leaf_ends();
                self.quote -= 1;
            }
            TagEnd::List(_) => {
                self.leaf_ends();
                self.lists.pop();
            }
            TagEnd::Item => {
                self.leaf_ends();
                // An item with nothing in it is still one.
                if self.marker.is_some() {
                    self.block(Is::Paragraph { runs: Vec::new() });
                }
            }
            TagEnd::TableCell => {
                let cell = linked(std::mem::take(&mut self.runs));
                if let Some(t) = &mut self.table {
                    match t.rows.last_mut() {
                        Some(row) if !t.in_head => row.push(cell),
                        _ => t.head.push(cell),
                    }
                }
            }
            TagEnd::TableHead => {
                if let Some(t) = &mut self.table {
                    t.in_head = false;
                }
            }
            TagEnd::Table => {
                if let Some(t) = self.table.take() {
                    self.block(Is::Table {
                        align: t.align,
                        head: t.head,
                        rows: t.rows,
                    });
                }
            }
            TagEnd::Emphasis => self.style.emphasis -= 1,
            TagEnd::Strong => self.style.strong -= 1,
            TagEnd::Strikethrough => self.style.strike -= 1,
            TagEnd::Link => self.link = None,
            TagEnd::Image => {
                let link = self.image.take().flatten();
                // Its words, or its address when it has none.
                let words: String = self.image_words.drain(..).collect();
                let text = if words.is_empty() {
                    link.clone().unwrap_or_default()
                } else {
                    words
                };
                self.add(Run {
                    text,
                    image: true,
                    link,
                    ..Run::default()
                });
            }
            _ => {}
        }
    }

    fn push(&mut self, text: &str, code: bool) {
        if text.is_empty() {
            return;
        }
        if let Some(Leaf::Code(_, body)) = &mut self.leaf {
            return body.push_str(text);
        }
        if self.image.is_some() {
            return self.image_words.push_str(text);
        }
        let run = self.styled(text, code);
        self.add(run);
    }

    fn styled(&self, text: &str, code: bool) -> Run {
        Run {
            text: text.to_string(),
            strong: self.style.strong > 0,
            emphasis: self.style.emphasis > 0,
            strike: self.style.strike > 0,
            code,
            image: false,
            link: self.link.clone().flatten(),
        }
    }

    /// `run` after the others, one with them when it is styled as the last.
    fn add(&mut self, run: Run) {
        if self.leaf.is_none() && self.table.is_none() {
            // Text straight in a tight list's item is a paragraph of its own.
            self.leaf = Some(Leaf::Paragraph);
        }
        if let Some(last) = self.runs.last_mut() {
            let same = (
                last.strong,
                last.emphasis,
                last.strike,
                last.code,
                last.image,
                &last.link,
            ) == (
                run.strong,
                run.emphasis,
                run.strike,
                run.code,
                run.image,
                &run.link,
            );
            if same && !run.image {
                return last.text.push_str(&run.text);
            }
        }
        self.runs.push(run);
    }

    fn leaf_starts(&mut self, leaf: Leaf) {
        self.leaf_ends();
        self.leaf = Some(leaf);
    }

    fn leaf_ends(&mut self) {
        let Some(leaf) = self.leaf.take() else { return };
        let mut runs = linked(std::mem::take(&mut self.runs));
        let is = match leaf {
            Leaf::Paragraph => Is::Paragraph { runs },
            Leaf::Html => {
                if let Some(last) = runs.last_mut() {
                    if last.text.ends_with('\n') {
                        last.text.pop();
                    }
                }
                Is::Paragraph { runs }
            }
            Leaf::Heading(level) => Is::Heading { level, runs },
            Leaf::Code(language, mut text) => {
                if text.ends_with('\n') {
                    text.pop();
                }
                Is::Code { language, text }
            }
        };
        self.block(is);
    }

    fn block(&mut self, is: Is) {
        let rtl = match &is {
            Is::Paragraph { runs } | Is::Heading { runs, .. } => {
                runs.iter().flat_map(|r| r.text.chars()).find_map(strong) == Some(true)
            }
            _ => false,
        };
        self.out.push(Block {
            is,
            depth: self.lists.len() as u32,
            quote: self.quote,
            marker: self.marker.take(),
            rtl,
        });
    }
}

/// Whether `c` is a letter written right to left, or one written left to right; none when it is
/// neither (a digit, punctuation, a space): Unicode's strong characters, as a paragraph's direction
/// is found (UAX #9, P2), for the scripts written right to left.
fn strong(c: char) -> Option<bool> {
    let rtl = matches!(c as u32,
        0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF);
    if rtl {
        // Arabic's digits and marks are not letters: they decide nothing.
        return c.is_alphabetic().then_some(true);
    }
    c.is_alphabetic().then_some(false)
}

fn level_of(level: HeadingLevel) -> u8 {
    level as u8
}

fn align_of(a: Alignment) -> Align {
    match a {
        Alignment::None => Align::None,
        Alignment::Left => Align::Left,
        Alignment::Center => Align::Center,
        Alignment::Right => Align::Right,
    }
}

/// `runs`, each https address written bare in a plain one a link of its own.
fn linked(runs: Vec<Run>) -> Vec<Run> {
    let mut out = Vec::with_capacity(runs.len());
    for run in runs {
        if run.link.is_some() || run.code || run.image {
            out.push(run);
            continue;
        }
        let mut at = 0;
        for (start, end) in bare_links(&run.text) {
            let url = &run.text[start..end];
            if start > at {
                out.push(Run {
                    text: run.text[at..start].to_string(),
                    ..run.clone()
                });
            }
            out.push(Run {
                text: url.to_string(),
                link: Some(url.to_string()),
                ..run.clone()
            });
            at = end;
        }
        if at == 0 {
            out.push(run);
        } else if at < run.text.len() {
            out.push(Run {
                text: run.text[at..].to_string(),
                ..run
            });
        }
    }
    out
}

/// Where in `text` an https address is written bare: from `https://` to the first space, less the
/// punctuation that ends a sentence and a closing bracket not opened in it.
fn bare_links(text: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(i) = text[from..].find("https://").map(|i| i + from) {
        let starts_word = text[..i]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric());
        let mut end = text[i..]
            .find(|c: char| c.is_whitespace() || c == '<')
            .map_or(text.len(), |n| i + n);
        loop {
            let url = &text[i..end];
            let Some(last) = url.chars().next_back() else {
                break;
            };
            let unopened = (last == ')' && url.matches('(').count() < url.matches(')').count())
                || (last == ']' && url.matches('[').count() < url.matches(']').count());
            if ".,:;!?'\"".contains(last) || unopened {
                end -= last.len_utf8();
            } else {
                break;
            }
        }
        if starts_word && https(&text[i..end]).is_some() {
            found.push((i, end));
        }
        from = end.max(i + 8);
    }
    found
}

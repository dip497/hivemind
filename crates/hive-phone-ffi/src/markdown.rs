//! What an agent says, read as the core reads it (spec/markdown.md): its blocks, for the apps to
//! draw, and nothing for them to read again.

use hive_phone::markdown::{self, Align, Is, Marker, Run};

/// Text of one style; `link` an https address, the only kind opened.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TextRun {
    pub text: String,
    pub strong: bool,
    pub emphasis: bool,
    pub strike: bool,
    pub code: bool,
    /// An image, shown by its words.
    pub image: bool,
    pub link: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ColumnAlign {
    None,
    Left,
    Center,
    Right,
}

/// What starts a list's item.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ListMarker {
    Bullet,
    Number { n: u64 },
    Task { done: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum BlockKind {
    Paragraph {
        runs: Vec<TextRun>,
    },
    Heading {
        level: u8,
        runs: Vec<TextRun>,
    },
    Code {
        language: Option<String>,
        text: String,
    },
    Rule,
    Table {
        align: Vec<ColumnAlign>,
        head: Vec<Vec<TextRun>>,
        rows: Vec<Vec<Vec<TextRun>>>,
    },
}

/// One block: what it is, inside how many lists (`depth`) and quotes (`quote`), the marker of the
/// list item it starts, and whether it runs right to left.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TextBlock {
    pub kind: BlockKind,
    pub depth: u32,
    pub quote: u32,
    pub marker: Option<ListMarker>,
    /// A paragraph or heading whose first letter is written right to left.
    pub rtl: bool,
}

/// `text`'s blocks, in order.
#[uniffi::export]
pub fn markdown(text: String) -> Vec<TextBlock> {
    markdown::read(&text).into_iter().map(block).collect()
}

fn runs(runs: Vec<Run>) -> Vec<TextRun> {
    runs.into_iter()
        .map(|r| TextRun {
            text: r.text,
            strong: r.strong,
            emphasis: r.emphasis,
            strike: r.strike,
            code: r.code,
            image: r.image,
            link: r.link,
        })
        .collect()
}

fn block(b: markdown::Block) -> TextBlock {
    let kind = match b.is {
        Is::Paragraph { runs: r } => BlockKind::Paragraph { runs: runs(r) },
        Is::Heading { level, runs: r } => BlockKind::Heading {
            level,
            runs: runs(r),
        },
        Is::Code { language, text } => BlockKind::Code { language, text },
        Is::Rule => BlockKind::Rule,
        Is::Table { align, head, rows } => BlockKind::Table {
            align: align
                .into_iter()
                .map(|a| match a {
                    Align::None => ColumnAlign::None,
                    Align::Left => ColumnAlign::Left,
                    Align::Center => ColumnAlign::Center,
                    Align::Right => ColumnAlign::Right,
                })
                .collect(),
            head: head.into_iter().map(runs).collect(),
            rows: rows
                .into_iter()
                .map(|row| row.into_iter().map(runs).collect())
                .collect(),
        },
    };
    TextBlock {
        kind,
        depth: b.depth,
        quote: b.quote,
        marker: b.marker.map(|m| match m {
            Marker::Bullet => ListMarker::Bullet,
            Marker::Number { n } => ListMarker::Number { n },
            Marker::Task { done } => ListMarker::Task { done },
        }),
        rtl: b.rtl,
    }
}

//! What an agent and the person say to each other, as the apps show it (docs/design/phone-app-
//! 2026-10-02.md §5.4): told oldest first, each entry once, at most every 16 ms, and followed on
//! across the background and the device's reconnects from as far as it was told; told anew when
//! the agent begins another session.

use std::sync::Arc;

use hive_phone::{
    conversation,
    failure::Lost,
    talking::{Listener, Talking},
};

use crate::{phone::Phone, records::AgentRef, RUNTIME};

/// A tool the agent used: the use, by its id; the tool, by its name; and what the use is about (a
/// file, a command, …) when it says.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Tool {
    pub id: String,
    pub name: String,
    pub about: Option<String>,
}

/// What a tool gave back: of which use, its text, and whether it failed.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ToolResult {
    pub of: String,
    pub text: String,
    pub error: bool,
}

/// What an entry says, and who said it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Said {
    /// The person's words.
    Person { text: String },
    /// The agent's words, in markdown.
    Agent { text: String },
    /// A tool the agent used.
    ToolUse { tool: Tool },
    /// What a tool gave back.
    ToolOutput { result: ToolResult },
}

/// One thing said, when (ms since the epoch), and what.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Entry {
    pub id: String,
    pub at: u64,
    pub said: Said,
}

impl Entry {
    /// An entry as the core reads it: none that says other than one thing of one of these (the
    /// core hands on only those, `conversation::read_entries`).
    fn from_core(entry: conversation::Entry) -> Option<Self> {
        let said = match (entry.who.as_str(), entry.text, entry.tool, entry.result) {
            ("person", Some(text), None, None) => Said::Person { text },
            ("agent", Some(text), None, None) => Said::Agent { text },
            ("agent", None, Some(tool), None) => Said::ToolUse {
                tool: Tool {
                    id: tool.id,
                    name: tool.name,
                    about: tool.about,
                },
            },
            ("tool", None, None, Some(result)) => Said::ToolOutput {
                result: ToolResult {
                    of: result.of,
                    text: result.text,
                    error: result.error,
                },
            },
            _ => return None,
        };
        Some(Self {
            id: entry.id,
            at: entry.at,
            said,
        })
    }
}

/// What a conversation followed tells the app, from a thread of the core's: the app hops to its
/// own.
#[uniffi::export(with_foreign)]
pub trait ConversationListener: Send + Sync {
    /// What was said since it last told, oldest first, at most one telling every 16 ms. `anew`:
    /// in place of all it told before (or after a divider), as the first telling is, and each after
    /// the agent began another session (`/clear`); then it may tell nothing yet.
    fn said(&self, entries: Vec<Entry>, anew: bool);
    /// It is told no more, and why. Told once, last.
    fn ended(&self, why: ConversationEnded);
}

/// Why a conversation followed is told no more, as the app tells the person.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ConversationEnded {
    /// The device said no, in its words: no agent runs there, …
    Refused { why: String },
    /// Its workspace is not on that device now.
    NotHeld,
    /// That device is not one of the person's now.
    Unpaired,
}

impl From<Lost> for ConversationEnded {
    fn from(lost: Lost) -> Self {
        match lost {
            Lost::Refused(why) => Self::Refused { why },
            Lost::NotHeld(_) => Self::NotHeld,
            Lost::Unpaired(_) => Self::Unpaired,
        }
    }
}

/// A listener, as the core tells a conversation's news.
struct Listening(Arc<dyn ConversationListener>);

impl Listener for Listening {
    fn said(&self, entries: Vec<conversation::Entry>, anew: bool) {
        let entries = entries.into_iter().filter_map(Entry::from_core).collect();
        self.0.said(entries, anew)
    }

    fn ended(&self, why: Lost) {
        self.0.ended(why.into())
    }
}

/// A conversation followed until stopped.
#[derive(uniffi::Object)]
pub struct Conversation(Talking);

#[uniffi::export]
impl Conversation {
    /// It is told no more.
    pub fn stop(&self) {
        self.0.stop()
    }
}

#[uniffi::export]
impl Phone {
    /// Follow what `agent` and the person say to each other: `listener` is told the last of it the
    /// device sends, then each piece as it is said, and why it ended if it does.
    pub fn conversation(
        &self,
        agent: AgentRef,
        listener: Arc<dyn ConversationListener>,
    ) -> Arc<Conversation> {
        let _runtime = RUNTIME.enter();
        let listening = Arc::new(Listening(listener));
        let (device, workspace, tile) = (&agent.device, &agent.workspace, &agent.tile);
        let talking = Talking::start(&self.connections, device, workspace, tile, listening);
        Arc::new(Conversation(talking))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_entry_is_handed_on_whole_as_what_it_says_and_one_that_says_more_or_less_is_not() {
        let at = 1_790_000_000_000;
        let core = |id: &str, who: &str| conversation::Entry {
            id: id.into(),
            at,
            who: who.into(),
            text: None,
            tool: None,
            result: None,
        };
        let shown = |id: &str, said| Entry {
            id: id.into(),
            at,
            said,
        };
        let edit = || conversation::Tool {
            id: "u1".into(),
            name: "Edit".into(),
            about: Some("src/nav.ts".into()),
        };
        let failed = || conversation::ToolResult {
            of: "u1".into(),
            text: "no such file".into(),
            error: true,
        };
        let text = |text: &str| Some(text.to_string());
        let cases = [
            (
                conversation::Entry {
                    text: text("fix the nav"),
                    ..core("e1", "person")
                },
                Some(shown(
                    "e1",
                    Said::Person {
                        text: "fix the nav".into(),
                    },
                )),
            ),
            (
                conversation::Entry {
                    text: text("**On it.**"),
                    ..core("e2", "agent")
                },
                Some(shown(
                    "e2",
                    Said::Agent {
                        text: "**On it.**".into(),
                    },
                )),
            ),
            (
                conversation::Entry {
                    tool: Some(edit()),
                    ..core("e3", "agent")
                },
                Some(shown(
                    "e3",
                    Said::ToolUse {
                        tool: Tool {
                            id: "u1".into(),
                            name: "Edit".into(),
                            about: Some("src/nav.ts".into()),
                        },
                    },
                )),
            ),
            (
                conversation::Entry {
                    result: Some(failed()),
                    ..core("e4", "tool")
                },
                Some(shown(
                    "e4",
                    Said::ToolOutput {
                        result: ToolResult {
                            of: "u1".into(),
                            text: "no such file".into(),
                            error: true,
                        },
                    },
                )),
            ),
            // The agent's words and a tool at once, or a tool's result said by the person.
            (
                conversation::Entry {
                    text: text("and"),
                    tool: Some(edit()),
                    ..core("e5", "agent")
                },
                None,
            ),
            (
                conversation::Entry {
                    result: Some(failed()),
                    ..core("e6", "person")
                },
                None,
            ),
        ];
        for (said, handed) in cases {
            assert_eq!(Entry::from_core(said), handed);
        }
    }

    #[test]
    fn why_a_conversation_ends_is_told_apart_as_the_app_shows_it() {
        let cases = [
            (
                Lost::Refused("no agent runs there".into()),
                ConversationEnded::Refused {
                    why: "no agent runs there".into(),
                },
            ),
            (
                Lost::NotHeld("desk does not hold it".into()),
                ConversationEnded::NotHeld,
            ),
            (
                Lost::Unpaired("d9 is not yours".into()),
                ConversationEnded::Unpaired,
            ),
        ];
        for (core, app) in cases {
            assert_eq!(ConversationEnded::from(core), app);
        }
    }
}

//! What an agent and the person say to each other, as the apps show it (docs/design/phone-app-
//! 2026-10-02.md §5.4): told oldest first, each entry once, at most every 16 ms, and followed on
//! across the background and the device's reconnects from as far as it was told; told anew when
//! the agent begins another session.

use std::sync::Arc;

use hive_phone::{
    conversation,
    talking::{Listener, Talking},
};

use crate::{phone::Phone, records::AgentRef, RUNTIME};

/// Who said an entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Who {
    Person,
    Agent,
    /// A tool the agent used, giving back what it found or did.
    Tool,
}

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

/// One thing said, when (ms since the epoch), by whom: the person's text; the agent's text, in
/// markdown, or a tool it used; or what a tool gave back.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Entry {
    pub id: String,
    pub at: u64,
    pub who: Who,
    pub text: Option<String>,
    pub tool: Option<Tool>,
    pub result: Option<ToolResult>,
}

impl Entry {
    /// An entry as the core reads it: none said by anyone else.
    fn from_core(entry: conversation::Entry) -> Option<Self> {
        let who = match entry.who.as_str() {
            "person" => Who::Person,
            "agent" => Who::Agent,
            "tool" => Who::Tool,
            _ => return None,
        };
        Some(Self {
            id: entry.id,
            at: entry.at,
            who,
            text: entry.text,
            tool: entry.tool.map(|tool| Tool {
                id: tool.id,
                name: tool.name,
                about: tool.about,
            }),
            result: entry.result.map(|result| ToolResult {
                of: result.of,
                text: result.text,
                error: result.error,
            }),
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
    /// It is told no more, and why: the device refused it, its workspace is not on that device
    /// now, or the device is no longer one of the person's. Told once, last.
    fn ended(&self, why: String);
}

/// A listener, as the core tells a conversation's news.
struct Listening(Arc<dyn ConversationListener>);

impl Listener for Listening {
    fn said(&self, entries: Vec<conversation::Entry>, anew: bool) {
        let entries = entries.into_iter().filter_map(Entry::from_core).collect();
        self.0.said(entries, anew)
    }

    fn ended(&self, why: String) {
        self.0.ended(why)
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
    fn each_entry_is_handed_on_whole_as_said_by_whom_it_says() {
        let at = 1_790_000_000_000;
        let core = |id: &str, who: &str| conversation::Entry {
            id: id.into(),
            at,
            who: who.into(),
            text: None,
            tool: None,
            result: None,
        };
        let shown = |id: &str, who| Entry {
            id: id.into(),
            at,
            who,
            text: None,
            tool: None,
            result: None,
        };
        let cases = [
            (
                conversation::Entry {
                    text: Some("fix the nav".into()),
                    ..core("e1", "person")
                },
                Entry {
                    text: Some("fix the nav".into()),
                    ..shown("e1", Who::Person)
                },
            ),
            (
                conversation::Entry {
                    tool: Some(conversation::Tool {
                        id: "u1".into(),
                        name: "Edit".into(),
                        about: Some("src/nav.ts".into()),
                    }),
                    ..core("e2", "agent")
                },
                Entry {
                    tool: Some(Tool {
                        id: "u1".into(),
                        name: "Edit".into(),
                        about: Some("src/nav.ts".into()),
                    }),
                    ..shown("e2", Who::Agent)
                },
            ),
            (
                conversation::Entry {
                    result: Some(conversation::ToolResult {
                        of: "u1".into(),
                        text: "no such file".into(),
                        error: true,
                    }),
                    ..core("e3", "tool")
                },
                Entry {
                    result: Some(ToolResult {
                        of: "u1".into(),
                        text: "no such file".into(),
                        error: true,
                    }),
                    ..shown("e3", Who::Tool)
                },
            ),
        ];
        for (said, handed) in cases {
            assert_eq!(Entry::from_core(said), Some(handed));
        }
    }
}

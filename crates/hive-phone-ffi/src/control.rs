//! Driving the person's agents from the phone (docs/design/phone-app-2026-10-02.md §4, §5): what
//! may be started in a workspace, starting an agent there, interrupting its turn, closing it, and
//! what it changed; each a call on the connection to the device that holds the workspace, which
//! carries it out as the person.

use hive_phone::control;

use crate::{on_runtime, phone::Phone, records::AgentRef, PhoneError};

/// One of an agent's launch choices, `model` or `mode`: the values it lists; none, typed freely.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StartOption {
    pub id: String,
    pub label: String,
    pub values: Vec<String>,
}

/// An agent the device can start: `claude` · "Claude Code", and its launch choices.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct StartProgram {
    pub id: String,
    pub label: String,
    pub options: Vec<StartOption>,
}

/// A frame of the workspace: a folder to start an agent in, and the machine it is on, by name.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Frame {
    pub id: String,
    pub name: String,
    pub machine: String,
}

/// What may be started in a workspace: the agents, and the frames to start them in.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Startable {
    pub programs: Vec<StartProgram>,
    pub frames: Vec<Frame>,
}

/// An agent to start: which, in which frame (none: where the workspace starts its agents), with
/// its first prompt, model and mode (none: its own; never its unattended mode unless asked).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Start {
    pub program: String,
    pub frame: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
}

/// A file an agent changed: its status (`M`, `A`, `D`, `R` or `?`, new to git), and the lines the
/// patch adds to it and removes.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DiffFile {
    pub path: String,
    pub status: String,
    pub added: u32,
    pub removed: u32,
}

/// What an agent changed in the folder it runs in, since its last commit: the files, and the
/// unified diff, cut at 512 KiB (`truncated`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Diff {
    pub files: Vec<DiffFile>,
    pub patch: String,
    pub truncated: bool,
}

impl From<control::Startable> for Startable {
    fn from(s: control::Startable) -> Self {
        let option = |o: control::StartOption| StartOption {
            id: o.id,
            label: o.label,
            values: o.values,
        };
        let program = |p: control::StartProgram| StartProgram {
            id: p.id,
            label: p.label,
            options: p.options.into_iter().map(option).collect(),
        };
        let frame = |f: control::Frame| Frame {
            id: f.id,
            name: f.name,
            machine: f.machine,
        };
        Self {
            programs: s.programs.into_iter().map(program).collect(),
            frames: s.frames.into_iter().map(frame).collect(),
        }
    }
}

impl From<Start> for control::Start {
    fn from(s: Start) -> Self {
        Self {
            program: s.program,
            frame: s.frame,
            prompt: s.prompt,
            model: s.model,
            mode: s.mode,
        }
    }
}

impl From<control::Changes> for Diff {
    fn from(c: control::Changes) -> Self {
        let file = |f: control::ChangedFile| DiffFile {
            path: f.path,
            status: f.status,
            added: f.added,
            removed: f.removed,
        };
        Self {
            files: c.files.into_iter().map(file).collect(),
            patch: c.patch,
            truncated: c.truncated,
        }
    }
}

#[uniffi::export]
impl Phone {
    /// What may be started in `workspace`, which `device` holds.
    pub async fn startable(
        &self,
        device: String,
        workspace: String,
    ) -> Result<Startable, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&device, &workspace).await?;
            Ok(control::startable(&connection, &workspace).await?.into())
        })
        .await
    }

    /// Start an agent in `workspace`, which `device` holds, as `start` says: the agent, on its
    /// board from then on.
    pub async fn start(
        &self,
        device: String,
        workspace: String,
        start: Start,
    ) -> Result<AgentRef, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&device, &workspace).await?;
            let tile = control::start(&connection, &workspace, &start.into()).await?;
            Ok(AgentRef {
                device,
                workspace,
                tile,
            })
        })
        .await
    }

    /// Interrupt `agent`'s turn, with the keys its manifest says: whether it was; not when it was
    /// neither working nor waiting on the person.
    pub async fn interrupt(&self, agent: AgentRef) -> Result<bool, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&agent.device, &agent.workspace).await?;
            Ok(control::interrupt(&connection, &agent.workspace, &agent.tile).await?)
        })
        .await
    }

    /// Close `agent`: its session ends, and its tile leaves the board. Whether it was there to
    /// close; not when it was closed already.
    pub async fn close_agent(&self, agent: AgentRef) -> Result<bool, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&agent.device, &agent.workspace).await?;
            Ok(control::close(&connection, &agent.workspace, &agent.tile).await?)
        })
        .await
    }

    /// What `agent` changed in the folder it runs in.
    pub async fn diff(&self, agent: AgentRef) -> Result<Diff, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&agent.device, &agent.workspace).await?;
            Ok(control::diff(&connection, &agent.workspace, &agent.tile)
                .await?
                .into())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_may_be_started_and_what_changed_reach_the_apps_as_the_device_said_them() {
        let said = control::Startable {
            programs: vec![control::StartProgram {
                id: "claude".into(),
                label: "Claude Code".into(),
                options: vec![
                    control::StartOption {
                        id: "model".into(),
                        label: "Model".into(),
                        values: vec!["opus".into(), "sonnet".into()],
                    },
                    control::StartOption {
                        id: "mode".into(),
                        label: "Mode".into(),
                        values: vec![],
                    },
                ],
            }],
            frames: vec![control::Frame {
                id: "f1".into(),
                name: "api".into(),
                machine: "Priya's laptop".into(),
            }],
        };
        let option = |id: &str, label: &str, values: &[&str]| StartOption {
            id: id.into(),
            label: label.into(),
            values: values.iter().map(|v| v.to_string()).collect(),
        };
        assert_eq!(
            Startable::from(said),
            Startable {
                programs: vec![StartProgram {
                    id: "claude".into(),
                    label: "Claude Code".into(),
                    options: vec![
                        option("model", "Model", &["opus", "sonnet"]),
                        option("mode", "Mode", &[]),
                    ],
                }],
                frames: vec![Frame {
                    id: "f1".into(),
                    name: "api".into(),
                    machine: "Priya's laptop".into(),
                }],
            }
        );
        let changed = control::Changes {
            files: vec![control::ChangedFile {
                path: "notes.txt".into(),
                status: "?".into(),
                added: 3,
                removed: 1,
            }],
            patch: "+buy milk\n".into(),
            truncated: true,
        };
        assert_eq!(
            Diff::from(changed),
            Diff {
                files: vec![DiffFile {
                    path: "notes.txt".into(),
                    status: "?".into(),
                    added: 3,
                    removed: 1,
                }],
                patch: "+buy milk\n".into(),
                truncated: true,
            }
        );
    }

    #[test]
    fn an_agent_is_started_as_the_person_chose() {
        let chosen = Start {
            program: "claude".into(),
            frame: Some("f1".into()),
            prompt: Some("buy milk".into()),
            model: Some("opus".into()),
            mode: Some("plan".into()),
        };
        assert_eq!(
            control::Start::from(chosen),
            control::Start {
                program: "claude".into(),
                frame: Some("f1".into()),
                prompt: Some("buy milk".into()),
                model: Some("opus".into()),
                mode: Some("plan".into()),
            }
        );
    }
}

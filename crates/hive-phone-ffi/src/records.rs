//! What the phone shows (docs/design/phone-app-2026-10-02.md §5.2), as the apps are handed it, and
//! made from what the core knows.

use std::collections::BTreeMap;

use hive_phone::{agents, connections::Seen, person, workspace::Reply};

/// Whose devices these are: their name, and their colour, `#rrggbb`, or "" for none.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Person {
    pub name: String,
    pub color: String,
}

impl From<person::Person> for Person {
    fn from(person: person::Person) -> Self {
        Self {
            name: person.name,
            color: person.color,
        }
    }
}

/// What pairing came to: the device paired with, and whose the phone is now.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Paired {
    pub device: String,
    pub name: String,
    pub person: Option<Person>,
}

/// An agent, where it is: the device that runs it, its workspace and its tile.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AgentRef {
    pub device: String,
    pub workspace: String,
    pub tile: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AgentState {
    Idle,
    Working,
    Waiting,
    Done,
    Failed,
    Interrupted,
    Limited,
    Exited,
}

/// What an agent waits on the person for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum WaitKind {
    Permission,
    Question,
    Plan,
    Other,
}

/// An agent's wait: what for, since when (which names the wait), its plan, and whether its device
/// can allow or deny it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Waiting {
    pub kind: WaitKind,
    pub since: u64,
    pub plan: Option<String>,
    pub decide: bool,
}

/// The program an agent is: `claude` · "Claude Code".
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Program {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Agent {
    pub at: AgentRef,
    pub name: String,
    pub workspace_name: String,
    pub device_name: String,
    /// The machine it runs on, by name.
    pub machine: String,
    pub program: Option<Program>,
    pub state: AgentState,
    /// When it entered its state.
    pub since: Option<u64>,
    pub waiting: Option<Waiting>,
    pub can_interrupt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DeviceKind {
    Computer,
    Host,
}

/// One of the person's devices: whether it is connected now, when it was found away, and when it
/// last answered.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: DeviceKind,
    pub reachable: bool,
    pub away_since: Option<u64>,
    pub heard_at: Option<u64>,
}

/// A workspace one of the person's devices holds: its id and name, and the folder it is in there
/// when the device says.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Workspace {
    /// The device that holds it, by id.
    pub device: String,
    pub id: String,
    pub name: String,
    pub folder: Option<String>,
}

/// What the phone shows of the person's agents and devices, at a revision.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Overview {
    pub revision: u64,
    /// Every agent: one device's after another, each device's in its order (by workspace id, then
    /// tile).
    pub agents: Vec<Agent>,
    /// Those waiting on the person, the one waiting longest first.
    pub needs: Vec<Agent>,
    pub working: u32,
    pub devices: Vec<Device>,
    /// The workspaces each device holds, one device's after another: none unless given, so an app
    /// that makes an overview of its own need not name them.
    #[uniffi(default)]
    pub workspaces: Vec<Workspace>,
    pub person: Option<Person>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Decision {
    Allow,
    Deny,
}

/// What the person answers an agent waiting on them.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Answer {
    /// One line.
    Text { text: String },
    /// A permission whose wait says `decide`.
    Decide { decision: Decision },
    Plan {
        approve: bool,
        feedback: Option<String>,
    },
}

impl From<Answer> for Reply {
    fn from(answer: Answer) -> Self {
        match answer {
            Answer::Text { text } => Reply::Text(text),
            Answer::Decide { decision } => Reply::Decide {
                allow: decision == Decision::Allow,
            },
            Answer::Plan { approve, feedback } => Reply::Plan { approve, feedback },
        }
    }
}

/// The overview at `revision`, from what the phone knows of the person's devices (`seen`) and
/// whose they are, as each device last said (spec/agents.md "Following"): every agent, one device's
/// after another, of a device that does not list them those waiting on the person; those waiting
/// on the person as one list, the one waiting longest first; how many agents are at work; each
/// device, and the workspaces it holds.
pub fn overview(revision: u64, seen: &[Seen], person: Option<person::Person>) -> Overview {
    let named: BTreeMap<&str, &str> = seen
        .iter()
        .map(|device| (device.with.device.as_str(), device.with.name.as_str()))
        .collect();
    let lists = seen.iter().filter_map(|device| {
        let heard = device.heard.as_ref()?;
        Some(heard.listed(&device.with.device))
    });
    let all = agents::as_one(lists.collect());
    let shown = |agents: Vec<agents::Agent>| {
        let shown = agents.into_iter().filter_map(|a| shown(a, &named));
        shown.collect()
    };
    Overview {
        revision,
        agents: shown(all.agents),
        needs: shown(all.needs),
        working: u32::try_from(all.working).unwrap_or(u32::MAX),
        devices: seen
            .iter()
            .map(|device| Device {
                id: device.with.device.clone(),
                name: device.with.name.clone(),
                kind: if device.with.kind == "host" {
                    DeviceKind::Host
                } else {
                    DeviceKind::Computer
                },
                reachable: device.reachable,
                away_since: device.away_since,
                heard_at: device.heard.as_ref().map(|heard| heard.at),
            })
            .collect(),
        workspaces: seen
            .iter()
            .flat_map(|device| {
                let held = device.heard.iter().flat_map(|heard| &heard.workspaces);
                held.map(|held| Workspace {
                    device: device.with.device.clone(),
                    id: held.workspace.clone(),
                    name: held.name.clone(),
                    folder: held.folder.clone(),
                })
            })
            .collect(),
        person: person.map(Person::from),
    }
}

/// An agent as the apps show it, on the device that told of it (`named`: each device's name, by
/// its id). What it waits on the agent supervising it for (`approval`) is not the person's to
/// answer: it waits, on nothing of theirs.
fn shown(agent: agents::Agent, named: &BTreeMap<&str, &str>) -> Option<Agent> {
    let state = match agent.state.as_str() {
        "idle" => AgentState::Idle,
        "working" => AgentState::Working,
        "waiting" => AgentState::Waiting,
        "done" => AgentState::Done,
        "failed" => AgentState::Failed,
        "interrupted" => AgentState::Interrupted,
        "limited" => AgentState::Limited,
        "exited" => AgentState::Exited,
        _ => return None,
    };
    let waiting = agent.waiting.filter(|w| w.kind != "approval");
    let device_name = named
        .get(agent.device.as_str())
        .map_or(&agent.device[..], |n| n);
    let device_name = device_name.to_string();
    Some(Agent {
        at: AgentRef {
            device: agent.device,
            workspace: agent.workspace,
            tile: agent.tile,
        },
        name: agent.agent,
        workspace_name: agent.name,
        machine: if agent.machine.is_empty() {
            device_name.clone()
        } else {
            agent.machine
        },
        device_name,
        program: agent.program.map(|program| Program {
            id: program.id,
            label: program.label,
        }),
        state,
        since: Some(agent.since),
        waiting: waiting.map(|waiting| Waiting {
            kind: match waiting.kind.as_str() {
                "permission" => WaitKind::Permission,
                "question" => WaitKind::Question,
                "plan" => WaitKind::Plan,
                _ => WaitKind::Other,
            },
            since: waiting.since,
            plan: waiting.plan,
            decide: waiting.decide,
        }),
        can_interrupt: agent.interrupt,
    })
}

#[cfg(test)]
mod tests {
    use hive_phone::{
        identity::DeviceCertificate,
        needs::{Answer as Said, Heard, Need},
        pairing::PairedWith,
        workspace::Held,
    };

    use super::*;

    fn device(id: &str, name: &str, kind: &str) -> PairedWith {
        PairedWith {
            device: id.into(),
            name: name.into(),
            kind: kind.into(),
            certificate: DeviceCertificate {
                v: 1,
                person: "aa".repeat(32),
                device: id.into(),
                issued_at: 0,
                signature: String::new(),
            },
            addrs: vec![],
            relay: None,
        }
    }

    /// An agent as a device lists it, in `state` since `since`.
    fn agent(workspace: &str, tile: &str, state: &str, since: u64) -> agents::Agent {
        agents::Agent {
            workspace: workspace.into(),
            name: format!("{workspace}'s name"),
            tile: tile.into(),
            agent: format!("agent of {tile}"),
            program: None,
            state: state.into(),
            since,
            machine: "Priya's laptop".into(),
            waiting: None,
            interrupt: false,
            device: String::new(),
        }
    }

    /// An agent waiting for `kind` since `since`, as a device lists it.
    fn waiting(workspace: &str, tile: &str, kind: &str, since: u64) -> agents::Agent {
        agents::Agent {
            waiting: Some(agents::Waiting {
                kind: kind.into(),
                since,
                plan: None,
                decide: false,
            }),
            ..agent(workspace, tile, "waiting", since)
        }
    }

    fn held(workspace: &str, name: &str, folder: Option<&str>) -> Held {
        Held {
            workspace: workspace.into(),
            name: name.into(),
            folder: folder.map(str::to_string),
        }
    }

    #[test]
    fn the_overview_is_what_each_device_last_said_each_agent_on_the_device_that_said_it() {
        let listed = vec![
            agents::Agent {
                program: Some(agents::Program {
                    id: "claude".into(),
                    label: "Claude Code".into(),
                }),
                interrupt: true,
                ..agent("w1", "t1", "working", 10)
            },
            agents::Agent {
                waiting: Some(agents::Waiting {
                    kind: "permission".into(),
                    since: 30,
                    plan: None,
                    decide: true,
                }),
                ..waiting("w1", "t2", "permission", 30)
            },
            waiting("w1", "t5", "approval", 5),
        ];
        // A device that does not list its agents: what waits on the person there, as it answered.
        let plan = Need {
            workspace: "w2".into(),
            name: "w2's name".into(),
            tile: "t3".into(),
            agent: "agent of t3".into(),
            kind: "plan".into(),
            since: 20,
            plan: Some("do it".into()),
            machine: None,
            decide: false,
        };
        let seen = [
            Seen {
                with: device("d1", "desk", "app"),
                reachable: true,
                away_since: None,
                heard: Some(Heard {
                    at: 100,
                    answer: Said {
                        needs: vec![],
                        working: 1,
                    },
                    agents: Some(listed),
                    workspaces: vec![held("w1", "api", Some("/home/priya/api"))],
                }),
            },
            Seen {
                with: device("d2", "server", "host"),
                reachable: false,
                away_since: Some(50),
                heard: Some(Heard {
                    at: 40,
                    answer: Said {
                        needs: vec![plan],
                        working: 1,
                    },
                    agents: None,
                    workspaces: vec![held("w2", "web", None)],
                }),
            },
            Seen {
                with: device("d3", "laptop", "app"),
                reachable: false,
                away_since: None,
                heard: None,
            },
        ];
        let whose = person::Person {
            name: "Priya".into(),
            color: "#aa3366".into(),
        };
        let shown = overview(7, &seen, Some(whose));
        assert_eq!(shown.revision, 7);
        let at = |agents: &[Agent]| -> Vec<(String, String)> {
            let at = agents
                .iter()
                .map(|a| (a.at.device.clone(), a.at.tile.clone()));
            at.collect()
        };
        let pair = |device: &str, tile: &str| (device.to_string(), tile.to_string());
        assert_eq!(
            at(&shown.agents),
            [
                pair("d1", "t1"),
                pair("d1", "t2"),
                pair("d1", "t5"),
                pair("d2", "t3")
            ]
        );
        // Waiting on the person, the longest first: not the one waiting on the agent supervising it.
        assert_eq!(at(&shown.needs), [pair("d2", "t3"), pair("d1", "t2")]);
        assert_eq!(
            shown.agents[0],
            Agent {
                at: AgentRef {
                    device: "d1".into(),
                    workspace: "w1".into(),
                    tile: "t1".into(),
                },
                name: "agent of t1".into(),
                workspace_name: "w1's name".into(),
                device_name: "desk".into(),
                machine: "Priya's laptop".into(),
                program: Some(Program {
                    id: "claude".into(),
                    label: "Claude Code".into(),
                }),
                state: AgentState::Working,
                since: Some(10),
                waiting: None,
                can_interrupt: true,
            }
        );
        assert_eq!(
            shown.needs[1].waiting,
            Some(Waiting {
                kind: WaitKind::Permission,
                since: 30,
                plan: None,
                decide: true,
            })
        );
        let approval = &shown.agents[2];
        assert_eq!(
            (approval.state, &approval.waiting),
            (AgentState::Waiting, &None)
        );
        // Of the device that does not list them, as it answered: on the machine it is when it
        // names none.
        assert_eq!(
            shown.needs[0],
            Agent {
                at: AgentRef {
                    device: "d2".into(),
                    workspace: "w2".into(),
                    tile: "t3".into(),
                },
                name: "agent of t3".into(),
                workspace_name: "w2's name".into(),
                device_name: "server".into(),
                machine: "server".into(),
                program: None,
                state: AgentState::Waiting,
                since: Some(20),
                waiting: Some(Waiting {
                    kind: WaitKind::Plan,
                    since: 20,
                    plan: Some("do it".into()),
                    decide: false,
                }),
                can_interrupt: false,
            }
        );
        assert_eq!(shown.working, 2);
        let device = |id: &str, name: &str, kind, reachable, away_since, heard_at| Device {
            id: id.into(),
            name: name.into(),
            kind,
            reachable,
            away_since,
            heard_at,
        };
        assert_eq!(
            shown.devices,
            [
                device("d1", "desk", DeviceKind::Computer, true, None, Some(100)),
                device("d2", "server", DeviceKind::Host, false, Some(50), Some(40)),
                device("d3", "laptop", DeviceKind::Computer, false, None, None),
            ]
        );
        let workspace = |device: &str, id: &str, name: &str, folder: Option<&str>| Workspace {
            device: device.into(),
            id: id.into(),
            name: name.into(),
            folder: folder.map(str::to_string),
        };
        assert_eq!(
            shown.workspaces,
            [
                workspace("d1", "w1", "api", Some("/home/priya/api")),
                workspace("d2", "w2", "web", None),
            ]
        );
        let priya = Person {
            name: "Priya".into(),
            color: "#aa3366".into(),
        };
        assert_eq!(shown.person, Some(priya));
    }

    #[test]
    fn each_answer_goes_to_the_core_as_it_sends_it() {
        let decide = |decision| Answer::Decide { decision };
        let cases = [
            (Answer::Text { text: "y".into() }, Reply::Text("y".into())),
            (decide(Decision::Allow), Reply::Decide { allow: true }),
            (decide(Decision::Deny), Reply::Decide { allow: false }),
            (
                Answer::Plan {
                    approve: false,
                    feedback: Some("smaller steps".into()),
                },
                Reply::Plan {
                    approve: false,
                    feedback: Some("smaller steps".into()),
                },
            ),
        ];
        for (answer, reply) in cases {
            assert_eq!(Reply::from(answer.clone()), reply, "{answer:?}");
        }
    }
}

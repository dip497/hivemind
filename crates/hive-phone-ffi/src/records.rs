//! What the phone shows (docs/design/phone-app-2026-10-02.md §5.2), as the apps are handed it, and
//! made from what the core knows.

use std::collections::BTreeMap;

use hive_phone::{
    connections::Seen,
    needs::{self, Need},
    pairing::PairedWith,
    person,
    workspace::Reply,
};

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

impl DeviceKind {
    /// A device's kind as pairing names it: `host`, else a computer (`app`).
    pub(crate) fn named(kind: &str) -> Self {
        if kind == "host" {
            Self::Host
        } else {
            Self::Computer
        }
    }
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

/// What the phone shows of the person's agents and devices, at a revision.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Overview {
    pub revision: u64,
    /// Every agent: by device, then workspace, then name.
    pub agents: Vec<Agent>,
    /// Those waiting on the person, the one waiting longest first.
    pub needs: Vec<Agent>,
    pub working: u32,
    pub devices: Vec<Device>,
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
/// whose they are: what waits on the person, as each device last said, the one waiting longest
/// first; how many agents are at work; and each device. Every agent is what the devices' `agents`
/// streams send (spec/agents.md): none until the phone follows them.
pub fn overview(revision: u64, seen: &[Seen], person: Option<person::Person>) -> Overview {
    // A workspace is held by one device: the one whose answer lists it.
    let mut holders: BTreeMap<&str, &PairedWith> = BTreeMap::new();
    let mut answers = vec![];
    for device in seen {
        if let Some(heard) = &device.heard {
            for need in &heard.answer.needs {
                holders.insert(&need.workspace, &device.with);
            }
            answers.push(heard.answer.clone());
        }
    }
    let all = needs::as_one(answers);
    Overview {
        revision,
        agents: vec![],
        needs: all
            .needs
            .into_iter()
            .map(|need| {
                let device = holders[need.workspace.as_str()];
                waiting(need, device)
            })
            .collect(),
        working: u32::try_from(all.working).unwrap_or(u32::MAX),
        devices: seen
            .iter()
            .map(|device| Device {
                id: device.with.device.clone(),
                name: device.with.name.clone(),
                kind: DeviceKind::named(&device.with.kind),
                reachable: device.reachable,
                away_since: device.away_since,
                heard_at: device.heard.as_ref().map(|heard| heard.at),
            })
            .collect(),
        person: person.map(Person::from),
    }
}

/// An agent waiting on the person, on `device`, as its answer says.
fn waiting(need: Need, device: &PairedWith) -> Agent {
    let kind = match need.kind.as_str() {
        "permission" => WaitKind::Permission,
        "question" => WaitKind::Question,
        "plan" => WaitKind::Plan,
        _ => WaitKind::Other,
    };
    Agent {
        at: AgentRef {
            device: device.device.clone(),
            workspace: need.workspace,
            tile: need.tile,
        },
        name: need.agent,
        workspace_name: need.name,
        device_name: device.name.clone(),
        machine: need.machine.unwrap_or_else(|| device.name.clone()),
        program: None,
        state: AgentState::Waiting,
        since: Some(need.since),
        waiting: Some(Waiting {
            kind,
            since: need.since,
            plan: need.plan,
            decide: need.decide,
        }),
        can_interrupt: false,
    }
}

#[cfg(test)]
mod tests {
    use hive_phone::{
        identity::DeviceCertificate,
        needs::{Answer as Said, Heard},
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

    fn need(workspace: &str, tile: &str, kind: &str, since: u64) -> Need {
        Need {
            workspace: workspace.into(),
            name: format!("{workspace}'s name"),
            tile: tile.into(),
            agent: format!("agent of {tile}"),
            kind: kind.into(),
            since,
            plan: None,
            machine: None,
            decide: false,
        }
    }

    fn said(at: u64, needs: Vec<Need>, working: u64) -> Option<Heard> {
        Some(Heard {
            at,
            answer: Said { needs, working },
        })
    }

    #[test]
    fn the_overview_is_what_each_device_last_said_each_agent_on_the_device_that_said_it() {
        let seen = [
            Seen {
                with: device("d1", "desk", "app"),
                reachable: true,
                away_since: None,
                heard: said(
                    100,
                    vec![
                        Need {
                            decide: true,
                            machine: Some("Priya's laptop".into()),
                            ..need("w1", "t1", "permission", 30)
                        },
                        need("w1", "t2", "question", 10),
                    ],
                    2,
                ),
            },
            Seen {
                with: device("d2", "server", "host"),
                reachable: false,
                away_since: Some(50),
                heard: said(
                    40,
                    vec![Need {
                        plan: Some("do it".into()),
                        ..need("w2", "t3", "plan", 20)
                    }],
                    1,
                ),
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
        let at: Vec<_> = shown
            .needs
            .iter()
            .map(|a| (a.at.device.as_str(), a.at.tile.as_str()))
            .collect();
        assert_eq!(at, [("d1", "t2"), ("d2", "t3"), ("d1", "t1")]);
        assert_eq!(
            shown.needs[2],
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
                program: None,
                state: AgentState::Waiting,
                since: Some(30),
                waiting: Some(Waiting {
                    kind: WaitKind::Permission,
                    since: 30,
                    plan: None,
                    decide: true,
                }),
                can_interrupt: false,
            }
        );
        // An answer that names no machine: the device that gave it.
        assert_eq!(shown.needs[0].machine, "desk");
        let kind = |agent: &Agent| agent.waiting.as_ref().map(|w| w.kind);
        assert_eq!(kind(&shown.needs[0]), Some(WaitKind::Question));
        assert_eq!(
            shown.needs[1].waiting,
            Some(Waiting {
                kind: WaitKind::Plan,
                since: 20,
                plan: Some("do it".into()),
                decide: false,
            })
        );
        assert_eq!(shown.working, 3);
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

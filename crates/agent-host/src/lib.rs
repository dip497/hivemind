//! A prototype of the agent host in Rust, held to the same spec as the TypeScript host
//! (`spec/status.md`, `conformance/`). It ships only if it passes the whole suite and beats
//! the TypeScript host on the benchmark in `src/bin/bench.rs`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State { Idle, Working, Waiting, Done, Failed, Interrupted, Limited, Exited }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Permission, Question, Plan, Approval, Other }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome { Done, Failed, Interrupted, Limited }

/// A session's status: `spec/status.schema.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub state: State,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kind: Option<Kind>,
    pub subagents: Vec<String>,
    pub background: u32,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub awaiting: Option<u32>,
    pub compacting: bool,
}

impl Default for Status {
    fn default() -> Self { Status { state: State::Idle, kind: None, subagents: vec![], background: 0, awaiting: None, compacting: false } }
}

/// One input to the fold: a canonical event, or a fact the host observed.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Input {
    Fact { fact: String },
    Event {
        event: String,
        #[serde(default)] outcome: Option<Outcome>,
        #[serde(default)] kind: Option<Kind>,
        #[serde(default, rename = "agentId")] agent_id: Option<String>,
        #[serde(default)] background: Option<u32>,
        #[serde(default)] awaiting: Option<u32>,
    },
}

/// `spec/status.md`: the same inputs in the same order give the same status in every host.
pub fn fold(s: &Status, input: &Input) -> Status {
    if s.state == State::Exited { return s.clone(); }
    let to = |state: State, kind: Option<Kind>| Status { state, kind, ..s.clone() };
    let leaving = |state: State| Status { state, kind: None, awaiting: None, ..s.clone() };
    match input {
        Input::Fact { fact } => match fact.as_str() {
            "exited" => leaving(State::Exited),
            "interrupt" if matches!(s.state, State::Working | State::Waiting) => leaving(State::Interrupted),
            "quiet" if s.state == State::Working && s.awaiting.is_some() => leaving(State::Idle),
            _ => s.clone(),
        },
        Input::Event { event, outcome, kind, agent_id, background, awaiting } => match event.as_str() {
            "turn.started" => leaving(State::Working),
            "turn.ended" => {
                let background = background.unwrap_or(0);
                match (outcome.unwrap_or(Outcome::Done), awaiting.unwrap_or(0)) {
                    (Outcome::Done, n) if n > 0 => Status { background, awaiting: Some(n), ..leaving(State::Working) },
                    (Outcome::Done, _) => Status { background, ..leaving(State::Done) },
                    (Outcome::Failed, _) => Status { background, ..leaving(State::Failed) },
                    (Outcome::Interrupted, _) => Status { background, ..leaving(State::Interrupted) },
                    (Outcome::Limited, _) => Status { background, ..leaving(State::Limited) },
                }
            }
            "input.requested" => to(State::Waiting, Some(kind.unwrap_or(Kind::Other))),
            "input.resolved" if s.state == State::Waiting => to(State::Working, None),
            "subagent.started" => match agent_id {
                Some(id) if !s.subagents.contains(id) => {
                    let mut subagents = s.subagents.clone();
                    subagents.push(id.clone());
                    Status { subagents, ..s.clone() }
                }
                _ => s.clone(),
            },
            "subagent.stopped" => {
                let left = match agent_id {
                    Some(id) => Status { subagents: s.subagents.iter().filter(|x| *x != id).cloned().collect(), ..s.clone() },
                    None => s.clone(),
                };
                match awaiting {
                    Some(n) if s.state == State::Working && s.awaiting.is_some() => {
                        if *n > 0 { Status { awaiting: Some(*n), ..left } } else { Status { state: State::Done, awaiting: None, ..left } }
                    }
                    _ => left,
                }
            }
            "compacting.started" => Status { compacting: true, ..s.clone() },
            "compacting.ended" => Status { compacting: false, ..s.clone() },
            _ => s.clone(),
        },
    }
}

#[cfg(test)]
mod conformance {
    use super::*;

    #[derive(Deserialize)]
    struct Case { name: String, inputs: Vec<Input>, expect: Status }
    #[derive(Deserialize)]
    struct Suite { cases: Vec<Case> }

    #[test]
    fn status_cases() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../conformance/status.json")).unwrap();
        let suite: Suite = serde_json::from_str(&raw).unwrap();
        assert!(!suite.cases.is_empty());
        for c in suite.cases {
            let got = c.inputs.iter().fold(Status::default(), |s, i| fold(&s, i));
            assert_eq!(got, c.expect, "{}", c.name);
        }
    }
}

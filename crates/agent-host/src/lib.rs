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
    pub compacting: bool,
}

impl Default for Status {
    fn default() -> Self { Status { state: State::Idle, kind: None, subagents: vec![], background: 0, compacting: false } }
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
    },
}

/// `spec/status.md`: the same inputs in the same order give the same status in every host.
pub fn fold(s: &Status, input: &Input) -> Status {
    if s.state == State::Exited { return s.clone(); }
    let to = |state: State, kind: Option<Kind>| Status { state, kind, ..s.clone() };
    match input {
        Input::Fact { fact } => match fact.as_str() {
            "exited" => to(State::Exited, None),
            "interrupt" if matches!(s.state, State::Working | State::Waiting) => to(State::Interrupted, None),
            _ => s.clone(),
        },
        Input::Event { event, outcome, kind, agent_id, background } => match event.as_str() {
            "turn.started" => to(State::Working, None),
            "turn.ended" => {
                let state = match outcome.unwrap_or(Outcome::Done) {
                    Outcome::Done => State::Done, Outcome::Failed => State::Failed,
                    Outcome::Interrupted => State::Interrupted, Outcome::Limited => State::Limited,
                };
                Status { background: background.unwrap_or(0), ..to(state, None) }
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
            "subagent.stopped" => match agent_id {
                Some(id) => Status { subagents: s.subagents.iter().filter(|x| *x != id).cloned().collect(), ..s.clone() },
                None => s.clone(),
            },
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

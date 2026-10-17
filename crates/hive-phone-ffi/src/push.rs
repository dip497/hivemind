//! Told on the phone what happens on the person's devices while the app is away
//! (docs/design/phone-app-2026-10-02.md, P6; spec/push.md): where the app's push service tells
//! it, given to each device; and what a notice the service hands the app says.

use std::time::Duration;

use hive_phone::push::{self, Platform, Took};
use serde_json::Value;
use tokio::task::JoinSet;

use crate::{
    on_runtime,
    phone::Phone,
    records::{AgentRef, JoinRef, WaitKind},
    PhoneError,
};

/// How long reading a notice asks the person's devices which holds its workspace, when what they
/// last said does not say: a push handler has seconds, not the time a device has to answer.
const HOLDER_WITHIN: Duration = Duration::from_secs(3);

/// Where the app's push service tells the phone.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum PushAt {
    /// A UnifiedPush distributor's endpoint (Android).
    UnifiedPush { endpoint: String },
    /// Apple's push service, by the app's device token in hex (iOS); `sandbox` for a development
    /// build. Only a push server on the person's network tells it there.
    Apns { token: String, sandbox: bool },
}

/// Where the phone is told now: through the push server `via`, when it is; the devices that took
/// it, by name; those away, not reached or not answering in time (call again as the app comes to
/// the foreground, and an away one takes it then); those that said no, and why; and, when the push
/// server would not take the endpoint, why.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PushTold {
    pub via: Option<String>,
    pub told: Vec<String>,
    pub away: Vec<String>,
    #[uniffi(default)]
    pub refused: Vec<PushRefused>,
    pub unregistered: Option<String>,
}

/// A device that would not take where the phone is told: by name, and why, in its words.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PushRefused {
    pub device: String,
    pub why: String,
}

/// What a notice says. The same agent, workspace and `since` told by two devices is one notice.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Notice {
    /// An agent began waiting on the person; `decide` when its device can allow or deny it from
    /// the notice itself.
    Waits {
        agent: AgentRef,
        agent_name: String,
        workspace_name: String,
        kind: WaitKind,
        since: u64,
        decide: bool,
    },
    Finished {
        agent: AgentRef,
        agent_name: String,
        workspace_name: String,
        since: u64,
    },
    Failed {
        agent: AgentRef,
        agent_name: String,
        workspace_name: String,
        since: u64,
    },
    /// Someone, `who` as they call themselves, asks to join the workspace `workspace_name` with a
    /// link for `role`, while none of the person's windows is there: Allow / Deny with `let_in`.
    Join {
        join: JoinRef,
        who: String,
        workspace_name: String,
        role: String,
        since: u64,
    },
    /// One of the person's devices, found away, is back.
    Back {
        device: String,
        name: String,
        since: u64,
    },
}

/// What `notice` says, its agent on `device`; none for a kind the phone does not know.
fn notice_of(notice: &Value, device: String) -> Option<Notice> {
    let text = |key: &str| notice[key].as_str().unwrap_or_default().to_string();
    let since = notice["since"].as_u64().unwrap_or(0);
    let agent = || AgentRef {
        device: device.clone(),
        workspace: text("workspace"),
        tile: text("tile"),
    };
    match notice["t"].as_str()? {
        "needs" => Some(Notice::Waits {
            agent: agent(),
            agent_name: text("agent"),
            workspace_name: text("name"),
            kind: match notice["kind"].as_str() {
                Some("permission") => WaitKind::Permission,
                Some("question") => WaitKind::Question,
                Some("plan") => WaitKind::Plan,
                _ => WaitKind::Other,
            },
            since,
            decide: notice["decide"] == true,
        }),
        "finished" => Some(Notice::Finished {
            agent: agent(),
            agent_name: text("agent"),
            workspace_name: text("name"),
            since,
        }),
        "failed" => Some(Notice::Failed {
            agent: agent(),
            agent_name: text("agent"),
            workspace_name: text("name"),
            since,
        }),
        "join" => Some(Notice::Join {
            join: JoinRef {
                device,
                workspace: text("workspace"),
                req: notice["req"].as_u64()?,
            },
            who: text("who"),
            workspace_name: text("name"),
            role: text("role"),
            since,
        }),
        "back" => Some(Notice::Back {
            device: text("device"),
            name: text("name"),
            since,
        }),
        _ => None,
    }
}

#[uniffi::export]
impl Phone {
    /// Be told at `at` what happens on the person's devices (spec/push.md): through the network's
    /// push server when it has one that tells phones there, else directly; each device is given
    /// where.
    pub async fn push_to(&self, at: PushAt) -> Result<PushTold, PhoneError> {
        let (identity, connections) = (self.identity.clone(), self.connections.clone());
        on_runtime(async move {
            let at = match &at {
                PushAt::UnifiedPush { endpoint } => push::PushAt::Endpoint(endpoint),
                PushAt::Apns { token, sandbox } => push::PushAt::Token {
                    platform: Platform::Apns,
                    token,
                    sandbox: *sandbox,
                },
            };
            let push::Subscribing {
                subscription,
                via,
                unregistered,
            } = push::subscribing(&identity, at).await?;
            let mut telling = JoinSet::new();
            for device in identity.devices() {
                let (connections, subscription) = (connections.clone(), subscription.clone());
                telling.spawn(async move {
                    let reaching = connections.to(&device.with.device);
                    (device.with.name, push::tell(reaching, &subscription).await)
                });
            }
            let (mut told, mut away, mut refused) = (vec![], vec![], vec![]);
            while let Some(Ok((name, took))) = telling.join_next().await {
                match took {
                    Took::Yes => told.push(name),
                    Took::Away => away.push(name),
                    Took::Refused(why) => refused.push(PushRefused { device: name, why }),
                }
            }
            told.sort();
            away.sort();
            refused.sort_by(|a, b| a.device.cmp(&b.device));
            Ok(PushTold {
                via,
                told,
                away,
                refused,
                unregistered,
            })
        })
        .await
    }

    /// The VAPID key (RFC 8292, base64url) of the push server on the person's network that tells
    /// phones through UnifiedPush: for the app to give its distributor as it registers (Android's
    /// `UnifiedPush.register(…, vapid)`), so one that asks for a key takes what that server posts.
    /// None on a network without such a server.
    pub fn push_vapid(&self) -> Option<String> {
        push::vapid(&self.identity)
    }

    /// What `body`, a notice the app's push service handed it, says: none for one not to show (a
    /// device back the phone did not find away, or a kind it does not know). Its agent's device is
    /// the one that holds its workspace, as last heard, else as the devices say when asked now, all
    /// at once and for three seconds at most, so it is read within a push handler's few seconds:
    /// none ("") when none said by then.
    pub async fn read_notice(&self, body: Vec<u8>) -> Result<Option<Notice>, PhoneError> {
        let (identity, connections) = (self.identity.clone(), self.connections.clone());
        let heard = self.overview().workspaces;
        on_runtime(async move {
            let Some(notice) = push::notice(&identity, &body)? else {
                return Ok(None);
            };
            let workspace = notice["workspace"].as_str().unwrap_or_default();
            let mut device = heard
                .into_iter()
                .find(|w| w.id == workspace)
                .map(|w| w.device);
            if device.is_none() && !workspace.is_empty() {
                device = connections.holder_of(workspace, HOLDER_WITHIN).await;
            }
            Ok(notice_of(&notice, device.unwrap_or_default()))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn at(tile: &str) -> AgentRef {
        AgentRef {
            device: "d1".into(),
            workspace: "w1".into(),
            tile: tile.into(),
        }
    }

    #[test]
    fn a_notice_says_which_agent_on_which_device_waits_finished_or_failed_who_asks_to_join_or_which_device_is_back(
    ) {
        let said = |t: &str, kind: Option<&str>, decide: Option<bool>| {
            let mut n = json!({ "v": 1, "t": t, "workspace": "w1", "name": "api", "tile": "t1",
                "agent": "Editing Nav.tsx", "since": 1_790_000_000_000u64 });
            if let Some(kind) = kind {
                n["kind"] = json!(kind);
            }
            if let Some(decide) = decide {
                n["decide"] = json!(decide);
            }
            notice_of(&n, "d1".into())
        };
        let waits = |kind, decide| {
            Some(Notice::Waits {
                agent: at("t1"),
                agent_name: "Editing Nav.tsx".into(),
                workspace_name: "api".into(),
                kind,
                since: 1_790_000_000_000,
                decide,
            })
        };
        assert_eq!(
            said("needs", Some("permission"), Some(true)),
            waits(WaitKind::Permission, true)
        );
        assert_eq!(
            said("needs", Some("question"), None),
            waits(WaitKind::Question, false)
        );
        assert_eq!(
            said("needs", Some("plan"), Some(false)),
            waits(WaitKind::Plan, false)
        );
        assert_eq!(
            said("needs", Some("approval"), None),
            waits(WaitKind::Other, false)
        );
        let ended = |agent_name: &str| (at("t1"), agent_name.to_string(), "api".to_string());
        let (agent, agent_name, workspace_name) = ended("Editing Nav.tsx");
        assert_eq!(
            said("finished", None, None),
            Some(Notice::Finished {
                agent: agent.clone(),
                agent_name: agent_name.clone(),
                workspace_name: workspace_name.clone(),
                since: 1_790_000_000_000
            })
        );
        assert_eq!(
            said("failed", None, None),
            Some(Notice::Failed {
                agent,
                agent_name,
                workspace_name,
                since: 1_790_000_000_000
            })
        );
        let back = json!({ "v": 1, "t": "back", "device": "d2", "name": "desk", "since": 7 });
        assert_eq!(
            notice_of(&back, String::new()),
            Some(Notice::Back {
                device: "d2".into(),
                name: "desk".into(),
                since: 7
            })
        );
        assert_eq!(
            said("waved", None, None),
            None,
            "a kind the phone does not know"
        );
        assert_eq!(notice_of(&json!({ "v": 1 }), "d1".into()), None);
        let join = json!({ "v": 1, "t": "join", "workspace": "w1", "name": "api", "req": 3,
            "who": "Priya", "role": "edit", "since": 9 });
        assert_eq!(
            notice_of(&join, "d1".into()),
            Some(Notice::Join {
                join: JoinRef {
                    device: "d1".into(),
                    workspace: "w1".into(),
                    req: 3
                },
                who: "Priya".into(),
                workspace_name: "api".into(),
                role: "edit".into(),
                since: 9
            })
        );
        let mut unnumbered = join.clone();
        unnumbered["req"] = json!(null);
        assert_eq!(
            notice_of(&unnumbered, "d1".into()),
            None,
            "a question with no number cannot be answered"
        );
    }
}

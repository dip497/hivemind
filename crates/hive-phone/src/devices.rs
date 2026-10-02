//! The person's devices, as the phone knows them (spec/pairing.md, "After"): one entry each, kept
//! in `devices.json` beside its keys as the app keeps its own, written whole and readable by its
//! user alone. They are the person's the phone's own certificate names; an entry whose certificate
//! does not verify, or names someone else, is not one of them. The apps it paired with tell it of
//! the person's other computers and hosts, which it reaches too (0.7). What the phone asks one of
//! them on its `device` stream, and unpairing (spec/pairing.md, "Unpairing").

use std::{collections::BTreeMap, fs, time::Duration};

use anyhow::{bail, Context, Result};
use hive_net::frames::{read_frame, write_frame};
use iroh::{endpoint::Connection, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    failure::Failure,
    identity::{write_private, Identity},
    needs,
    pairing::{Paired, PairedWith},
    person, push,
};

/// How long a device has to answer the phone before it is said to be away.
pub const ANSWER_WITHIN: Duration = Duration::from_secs(10);

/// One of the person's devices, and when the phone paired with it, or learned of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    #[serde(flatten)]
    pub with: PairedWith,
    pub paired_at: u64,
    /// The apps that told this phone of it (spec/pairing.md 0.7): none for one it paired with.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub via: Vec<String>,
}

impl Identity {
    /// The person's devices this phone paired with.
    pub fn devices(&self) -> Vec<PairedDevice> {
        let Some(mine) = self.certificate() else {
            return vec![];
        };
        let Ok(text) = fs::read_to_string(self.dir().join("devices.json")) else {
            return vec![];
        };
        let Ok(Value::Array(all)) = serde_json::from_str(&text) else {
            return vec![];
        };
        all.into_iter()
            .filter_map(|d| serde_json::from_value::<PairedDevice>(d).ok())
            .filter(|d| {
                let c = &d.with.certificate;
                c.verifies() && c.device == d.with.device && c.person == mine.person
            })
            .collect()
    }

    /// Keep what pairing gave, at `now` (ms since the epoch): the certificate as this phone's
    /// own, the device paired with among the person's, and the network it is on. A phone is the
    /// person it paired with last: another person's devices, and their network, are forgotten.
    pub fn keep(&self, paired: &Paired, now: u64) -> Result<()> {
        let same = self
            .certificate()
            .is_some_and(|c| c.person == paired.certificate.person);
        let mut devices: Vec<PairedDevice> = if same { self.devices() } else { vec![] };
        devices.retain(|d| d.with.device != paired.with.device);
        devices.push(PairedDevice {
            with: paired.with.clone(),
            paired_at: now,
            via: vec![],
        });
        self.certify(&paired.certificate)?;
        if !same {
            needs::forget_heard(self, None)?;
            self.forget_person()?;
        }
        // The network the app is on; the same person's app that gives none leaves it as it was.
        if paired.network.is_some() || !same {
            self.keep_network(paired.network.as_deref())?;
        }
        self.write_devices(&devices)
    }

    /// Forget `device`: no longer one of the person's devices to this phone, and what it last said
    /// not kept. False when it was not one.
    pub fn forget(&self, device: &str) -> Result<bool> {
        let mut devices = self.devices();
        let before = devices.len();
        devices.retain(|d| d.with.device != device);
        if devices.len() == before {
            return Ok(false);
        }
        self.write_devices(&devices)?;
        needs::forget_heard(self, Some(device))?;
        Ok(true)
    }

    /// The person's computers and hosts the app `by` paired with, as it says (`told`, spec/
    /// pairing.md 0.7): each that is this phone's person's, and no phone, is kept as `by` told of
    /// it, at `now` when it is new here; each that `by` told of before and lists no more is
    /// forgotten, unless another app told of it too. One this phone paired with itself is left as
    /// it is.
    pub fn learn(&self, by: &str, told: &[Value], now: u64) -> Result<()> {
        let Some(mine) = self.certificate() else {
            return Ok(());
        };
        let mut listed: BTreeMap<String, PairedWith> = told
            .iter()
            .filter_map(|d| serde_json::from_value::<PairedWith>(d.clone()).ok())
            .filter(|d| {
                let c = &d.certificate;
                d.kind != "phone" && c.verifies() && c.device == d.device && c.person == mine.person
            })
            .map(|d| (d.device.clone(), d))
            .collect();
        let before = self.devices();
        let (mut kept, mut forgot) = (vec![], vec![]);
        for d in &before {
            let named = listed.remove(&d.with.device);
            if d.via.is_empty() {
                kept.push(d.clone());
                continue;
            }
            let mut via: Vec<String> = d.via.iter().filter(|v| *v != by).cloned().collect();
            match named {
                Some(with) => {
                    via.push(by.to_string());
                    kept.push(PairedDevice {
                        with,
                        paired_at: d.paired_at,
                        via,
                    });
                }
                None if !via.is_empty() => kept.push(PairedDevice { via, ..d.clone() }),
                None => forgot.push(d.with.device.clone()),
            }
        }
        kept.extend(listed.into_values().map(|with| PairedDevice {
            with,
            paired_at: now,
            via: vec![by.to_string()],
        }));
        if kept != before {
            self.write_devices(&kept)?;
        }
        for device in forgot {
            needs::forget_heard(self, Some(&device))?;
        }
        Ok(())
    }

    /// What the apps this phone paired with answered when it asked which of the person's
    /// computers and hosts it may reach through each (`answers`, by the app that gave each), kept
    /// at `now`: the devices each tells of (spec/pairing.md 0.7), and whose they are as the app
    /// this phone paired with first among those that say (0.8).
    pub fn learn_all(&self, answers: &[(String, Value)], now: u64) -> Result<()> {
        let mut whose: Option<(u64, person::Person)> = None;
        for (by, answer) in answers {
            if let Some(told) = answer.get("devices").and_then(Value::as_array) {
                self.learn(by, told, now)?;
            }
            let paired_at = self
                .devices()
                .iter()
                .find(|d| d.with.device == *by && d.via.is_empty())
                .map(|d| d.paired_at);
            let said = answer.get("profile").and_then(person::read_profile);
            if let (Some(at), Some(person)) = (paired_at, said) {
                if whose.as_ref().is_none_or(|(first, _)| at < *first) {
                    whose = Some((at, person));
                }
            }
        }
        match whose {
            Some((_, person)) => self.keep_person(&person),
            None => Ok(()),
        }
    }

    /// Ask each app this phone paired with, on `endpoint`, which of the person's computers and
    /// hosts it may reach through it, and whose they are, and keep what they say at `now`
    /// (`learn_all`): one that does not answer leaves what it said before.
    pub async fn learn_from(&self, endpoint: &Endpoint, now: u64) -> Result<()> {
        let mut asking = tokio::task::JoinSet::new();
        for app in self.devices() {
            if !app.via.is_empty() || app.with.kind != "app" {
                continue;
            }
            let endpoint = endpoint.clone();
            asking.spawn(async move {
                let asked = async {
                    let w = &app.with;
                    let at = hive_net::net::addr_of(&w.device, &w.addrs, &w.relay)?;
                    let connection = endpoint.connect(at, hive_net::ws::ALPN).await?;
                    let answer = ask(&connection, &json!({ "t": "devices" })).await?;
                    connection.close(0u32.into(), b"done");
                    Ok::<_, anyhow::Error>(answer)
                };
                let answer = tokio::time::timeout(ANSWER_WITHIN, asked).await;
                (app.with.device, answer)
            });
        }
        let mut answers = vec![];
        while let Some(Ok((by, answer))) = asking.join_next().await {
            if let Ok(Ok(answer)) = answer {
                answers.push((by, answer));
            }
        }
        self.learn_all(&answers, now)
    }

    fn write_devices(&self, devices: &[PairedDevice]) -> Result<()> {
        write_private(
            &self.dir().join("devices.json"),
            &format!("{}\n", serde_json::to_string_pretty(devices)?),
        )
    }

    /// Unpair this phone from `device`, its id, one it paired with itself (spec/pairing.md,
    /// "Unpairing"): told on `endpoint`, the device forgets the phone, and the phone forgets the
    /// device whether it could tell it or not, and the devices it learned of from it alone; the push
    /// server it registered at, if any, lets that device tell it nothing more. One it learned of
    /// from an app is unpaired there.
    pub async fn unpair_from(&self, endpoint: &Endpoint, device: &str) -> Result<Unpaired> {
        let all = self.devices();
        let Some(paired) = all.iter().find(|d| d.with.device == device) else {
            let failure = if all.is_empty() {
                Failure::NotPaired
            } else {
                Failure::Invalid(format!(
                    "{device} is not a device this phone is paired with"
                ))
            };
            return Err(failure.into());
        };
        if !paired.via.is_empty() {
            let through: Vec<_> = all
                .iter()
                .filter(|a| paired.via.contains(&a.with.device))
                .map(|a| a.with.name.as_str())
                .collect();
            let (name, through) = (&paired.with.name, through.join(", "));
            return Err(Failure::Invalid(format!(
                "{name} knows this phone through {through}: unpair from that"
            ))
            .into());
        }
        let told = self.unpair(endpoint, &paired.with).await?;
        let registered =
            async { push::register_again(self.dir(), self.key(), &push::senders(self)?).await };
        Ok(Unpaired {
            told,
            still_told: registered.await.err(),
        })
    }

    /// Unpair this phone from `device`: told on `endpoint`, it forgets the phone, and the phone
    /// forgets it whether it could tell it or not, and the devices it learned of from it alone.
    /// Whether it was told: one that was not still lists the phone.
    async fn unpair(&self, endpoint: &Endpoint, device: &PairedWith) -> Result<bool> {
        let told = async {
            let at = hive_net::net::addr_of(&device.device, &device.addrs, &device.relay)?;
            let connection = endpoint.connect(at, hive_net::ws::ALPN).await?;
            let answer = ask(&connection, &json!({ "t": "unpair" })).await?;
            connection.close(0u32.into(), b"done");
            if answer.get("ok").and_then(Value::as_bool) != Some(true) {
                bail!("{}", refusal(&answer));
            }
            Ok::<_, anyhow::Error>(())
        };
        let told = matches!(tokio::time::timeout(ANSWER_WITHIN, told).await, Ok(Ok(())));
        self.forget(&device.device)?;
        self.learn(&device.device, &[], 0)?;
        Ok(told)
    }
}

/// What unpairing a device came to.
#[derive(Debug)]
pub struct Unpaired {
    /// Whether the device was told: one that was not still lists the phone.
    pub told: bool,
    /// Why the push server this phone registered at still lets the device tell it, when it does.
    pub still_told: Option<anyhow::Error>,
}

/// Ask the device on `connection` `message` on its `device` stream: its answer, the first it
/// sends of the same `t`.
pub async fn ask(connection: &Connection, message: &Value) -> Result<Value> {
    let (mut send, mut recv) = hive_net::ws::open(connection, "device").await?;
    write_frame(&mut send, message.to_string().as_bytes()).await?;
    loop {
        let frame = read_frame(&mut recv)
            .await?
            .context("the device closed without answering")?;
        let answer: Value = serde_json::from_slice(&frame)?;
        if answer.get("t") == message.get("t") {
            return Ok(answer);
        }
    }
}

/// What a device's refusal says, or that it refused.
pub fn refusal(answer: &Value) -> &str {
    answer
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("the device refused")
}

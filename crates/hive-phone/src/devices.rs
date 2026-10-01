//! The person's devices, as the phone knows them (spec/pairing.md, "After"): one entry each, kept
//! in `devices.json` beside its keys as the app keeps its own, written whole and readable by its
//! user alone. They are the person's the phone's own certificate names; an entry whose certificate
//! does not verify, or names someone else, is not one of them. What the phone asks one of them on
//! its `device` stream, and unpairing (spec/pairing.md, "Unpairing").

use std::{fs, time::Duration};

use anyhow::{bail, Context, Result};
use hive_net::frames::{read_frame, write_frame};
use iroh::{endpoint::Connection, Endpoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    identity::{write_private, Identity},
    needs,
    pairing::{Paired, PairedWith},
};

/// How long a device has to answer the phone before it is said to be away.
pub const ANSWER_WITHIN: Duration = Duration::from_secs(10);

/// One of the person's devices, and when the phone paired with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    #[serde(flatten)]
    pub with: PairedWith,
    pub paired_at: u64,
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
    /// own, and the device paired with among the person's. A phone is the person it paired with
    /// last: another person's devices are forgotten.
    pub fn keep(&self, paired: &Paired, now: u64) -> Result<()> {
        let same = self
            .certificate()
            .is_some_and(|c| c.person == paired.certificate.person);
        let mut devices: Vec<PairedDevice> = if same { self.devices() } else { vec![] };
        devices.retain(|d| d.with.device != paired.with.device);
        devices.push(PairedDevice {
            with: paired.with.clone(),
            paired_at: now,
        });
        self.certify(&paired.certificate)?;
        if !same {
            needs::forget_heard(self, None)?;
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

    fn write_devices(&self, devices: &[PairedDevice]) -> Result<()> {
        write_private(
            &self.dir().join("devices.json"),
            &format!("{}\n", serde_json::to_string_pretty(devices)?),
        )
    }

    /// Unpair this phone from `device` (spec/pairing.md, "Unpairing"): told on `endpoint`, the
    /// device forgets the phone, and the phone forgets the device whether it could tell it or not.
    /// Whether the device was told: one that was not still lists the phone.
    pub async fn unpair(&self, endpoint: &Endpoint, device: &PairedWith) -> Result<bool> {
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
        Ok(told)
    }
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

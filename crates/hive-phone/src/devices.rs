//! The person's devices, as the phone knows them (spec/pairing.md, "After"): one entry each, kept
//! in `devices.json` beside its keys as the app keeps its own, written whole and readable by its
//! user alone. They are the person's the phone's own certificate names; an entry whose certificate
//! does not verify, or names someone else, is not one of them.

use std::fs;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    identity::{write_private, Identity},
    pairing::{Paired, PairedWith},
};

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
        write_private(
            &self.dir().join("devices.json"),
            &format!("{}\n", serde_json::to_string_pretty(&devices)?),
        )
    }
}

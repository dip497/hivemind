//! What a phone and the push role agree on (spec/push.md 0.3): where a phone is told, and what it
//! signs to register there.

use serde::{Deserialize, Serialize};

const REGISTER: &[u8] = b"hive/push-register/1\n";

/// Where a phone is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// A UnifiedPush distributor's address (Web Push): the notice as it came.
    Unifiedpush,
    /// Apple's push service, by the phone's device token.
    Apns,
    /// Google's (Firebase Cloud Messaging), by its registration token.
    Fcm,
}

impl Platform {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Unifiedpush => "unifiedpush",
            Self::Apns => "apns",
            Self::Fcm => "fcm",
        }
    }
}

/// What a phone signs to register: its key, where it is told, the devices that may tell it, and
/// when.
pub(crate) fn register_bytes(
    device: &str,
    platform: Platform,
    token: &str,
    sandbox: bool,
    senders: &[String],
    at: u64,
) -> Vec<u8> {
    let mut bytes = REGISTER.to_vec();
    for part in [
        device,
        platform.name(),
        token,
        if sandbox { "1" } else { "0" },
        &senders.join(","),
    ] {
        bytes.extend(part.as_bytes());
        bytes.push(b'\n');
    }
    bytes.extend(at.to_string().as_bytes());
    bytes
}

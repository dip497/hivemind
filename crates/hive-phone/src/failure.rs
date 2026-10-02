//! Why what the phone was asked did not happen, told apart as the apps tell the person (docs/design/
//! phone-app-2026-10-02.md §5.1): nothing paired yet, no device holding it answered, the device
//! said no, or what was given is not one. Anything else fails as itself.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The phone is paired with nothing yet.
    NotPaired,
    /// No device holding it answered: none could be reached, or none in time.
    Unreachable(String),
    /// The device said no: its words, and its code when it gave one (spec/workspace-api.md).
    Refused {
        code: Option<String>,
        message: String,
    },
    /// What was given is not one: not a pairing link, not one of the person's devices.
    Invalid(String),
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotPaired => {
                f.write_str("this phone is paired with nothing yet: pair it with your computer")
            }
            Self::Unreachable(message) | Self::Invalid(message) => f.write_str(message),
            Self::Refused { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for Failure {}

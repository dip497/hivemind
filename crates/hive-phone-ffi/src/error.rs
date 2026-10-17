//! The one error the apps are given (docs/design/phone-app-2026-10-02.md §5.1), flat: a kind, and
//! the words the person is shown. Kotlin has `PhoneException.NotPaired(message)`, Swift
//! `PhoneError.NotPaired(message:)`.

use hive_phone::failure::Failure;

#[derive(Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum PhoneError {
    /// Nothing is paired yet.
    #[error("{0}")]
    NotPaired(String),
    /// No device holding it answered.
    #[error("{0}")]
    Unreachable(String),
    /// The device said no, in its words.
    #[error("{0}")]
    Refused(String),
    /// Not a link, text too long, not one of the person's devices, …
    #[error("{0}")]
    Invalid(String),
    /// Anything else: the disk, the network, …
    #[error("{0}")]
    Failed(String),
}

impl From<anyhow::Error> for PhoneError {
    /// The core's failure as the apps tell it, in its own words: what the device refused as
    /// malformed is invalid.
    fn from(e: anyhow::Error) -> Self {
        let Some(failure) = e.downcast_ref::<Failure>() else {
            return Self::Failed(format!("{e:#}"));
        };
        let words = failure.to_string();
        match failure {
            Failure::NotPaired => Self::NotPaired(words),
            Failure::Unreachable(_) => Self::Unreachable(words),
            Failure::Refused {
                code: Some(code), ..
            } if code == "BAD_REQUEST" => Self::Invalid(words),
            Failure::Refused { .. } => Self::Refused(words),
            Failure::Invalid(_) => Self::Invalid(words),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cores_failures_are_told_apart_as_the_apps_tell_the_person_in_their_own_words() {
        let refused = |code: Option<&str>, message: &str| Failure::Refused {
            code: code.map(str::to_string),
            message: message.into(),
        };
        let cases: Vec<(anyhow::Error, PhoneError)> = vec![
            (
                Failure::NotPaired.into(),
                PhoneError::NotPaired(
                    "this phone is paired with nothing yet: pair it with your computer".into(),
                ),
            ),
            (
                Failure::Unreachable("desk did not answer".into()).into(),
                PhoneError::Unreachable("desk did not answer".into()),
            ),
            (
                refused(Some("FORBIDDEN"), "not yours to drive").into(),
                PhoneError::Refused("not yours to drive".into()),
            ),
            (
                refused(None, "that code has expired").into(),
                PhoneError::Refused("that code has expired".into()),
            ),
            // The device's own check of what it was given.
            (
                refused(Some("BAD_REQUEST"), "one line of at most 1000 characters").into(),
                PhoneError::Invalid("one line of at most 1000 characters".into()),
            ),
            (
                Failure::Invalid("d9 is not one of your devices".into()).into(),
                PhoneError::Invalid("d9 is not one of your devices".into()),
            ),
            // Told where it happened, still in its own words.
            (
                anyhow::Error::from(Failure::Unreachable("desk did not answer".into()))
                    .context("watching"),
                PhoneError::Unreachable("desk did not answer".into()),
            ),
            (
                anyhow::anyhow!("no space left").context("cannot write heard.json"),
                PhoneError::Failed("cannot write heard.json: no space left".into()),
            ),
        ];
        for (failure, told) in cases {
            assert_eq!(PhoneError::from(failure), told);
        }
    }
}

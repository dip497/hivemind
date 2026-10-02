//! Whose devices these are, as the person's app says (spec/pairing.md 0.8): the name the people
//! they work with see them by, and their colour (Settings → Profile), so the phone shows itself as
//! theirs. Kept beside the phone's keys, readable by its user alone, as the app this phone paired
//! with first says it; forgotten when the phone pairs with another person.

use std::fs;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::identity::{write_private, Identity};

const PERSON: &str = "person.json";
/// The longest name taken, in characters, as an app keeps one.
const NAME_MAX: usize = 64;

/// The person, as their app says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub name: String,
    /// `#rrggbb`; empty while they chose none.
    pub color: String,
}

/// The person a `profile` an app gave says: none for a name that is not text, empty, longer than
/// 64 characters or with a control character in it; a colour that is not `#rrggbb` (lowercase) is
/// taken as none chosen.
pub fn read_profile(profile: &Value) -> Option<Person> {
    let name = profile.get("name")?.as_str()?.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || name.chars().any(char::is_control) {
        return None;
    }
    let color = profile
        .get("color")
        .and_then(Value::as_str)
        .filter(|c| {
            c.len() == 7
                && c.starts_with('#')
                && c[1..]
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
        .unwrap_or("");
    Some(Person {
        name: name.to_string(),
        color: color.to_string(),
    })
}

impl Identity {
    /// Whose devices these are, as last told; none before an app said.
    pub fn person(&self) -> Option<Person> {
        fs::read_to_string(self.dir().join(PERSON))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
    }

    /// Keep `person` as whose devices these are.
    pub(crate) fn keep_person(&self, person: &Person) -> Result<()> {
        if self.person().as_ref() == Some(person) {
            return Ok(());
        }
        write_private(
            &self.dir().join(PERSON),
            &format!("{}\n", serde_json::to_string(person)?),
        )
    }

    /// Forget whose devices these were: the phone is another person's now.
    pub(crate) fn forget_person(&self) -> Result<()> {
        match fs::remove_file(self.dir().join(PERSON)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

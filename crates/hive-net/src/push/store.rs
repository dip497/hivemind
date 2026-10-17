//! The phones registered with the push role (spec/push.md 0.3), kept in `push.json` by handle:
//! each phone under one handle for good, its registration replaced only by one it signed later.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{bail, Result};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use super::wire::Platform;
use crate::state_file;

/// A phone's registration: which phone, where it is told, and by whom.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Registration {
    pub device: String,
    pub platform: Platform,
    pub token: String,
    /// Apple's development service, for a build of the phone's app that is not from the store.
    pub sandbox: bool,
    /// The devices that may tell it: the person's, as the phone named them.
    pub senders: Vec<String>,
    /// When the phone signed it.
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    /// By handle.
    #[serde(default)]
    phones: BTreeMap<String, Registration>,
}

pub(crate) struct Store {
    state: Mutex<State>,
    file: PathBuf,
}

impl Store {
    /// The registrations kept in `dir`.
    pub fn open(dir: &Path) -> Result<Self> {
        let file = dir.join("push.json");
        Ok(Self {
            state: Mutex::new(state_file::read(&file)?),
            file,
        })
    }

    /// Keep `phone`'s registration: its handle, the one it was given when it registered before.
    /// Refused when the one kept was signed no earlier (the same one sent again, say).
    pub fn register(&self, phone: Registration) -> Result<String> {
        let mut state = self.state.lock().unwrap();
        let kept = state.phones.iter().find(|(_, p)| p.device == phone.device);
        let handle = match kept {
            Some((_, p)) if p.at >= phone.at => bail!("a later registration of this phone is kept"),
            Some((handle, _)) => handle.clone(),
            None => {
                let mut bytes = [0u8; 16];
                SystemRandom::new()
                    .fill(&mut bytes)
                    .map_err(|_| anyhow::anyhow!("no randomness"))?;
                hex::encode(bytes)
            }
        };
        state.phones.insert(handle.clone(), phone);
        state_file::write(&self.file, &*state)?;
        Ok(handle)
    }

    /// The phone of `handle`.
    pub fn get(&self, handle: &str) -> Option<Registration> {
        self.state.lock().unwrap().phones.get(handle).cloned()
    }

    /// The phone of `handle` is told nowhere now: its registration `gone` is dropped, unless it
    /// registered anew since.
    pub fn drop_gone(&self, handle: &str, gone: &Registration) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.phones.get(handle) == Some(gone) {
            state.phones.remove(handle);
            state_file::write(&self.file, &*state)?;
        }
        Ok(())
    }
}

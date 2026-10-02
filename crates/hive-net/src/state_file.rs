//! What a server role keeps, in one JSON file (`access.json`, `push.json`): read whole as the role
//! starts, where none there is none yet but one that cannot be read stops it (so the next write
//! does not lose it), and written whole, readable by the server's user alone, on the disk before it
//! takes the last one's place.

use std::{fs, io::Write, path::Path};

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};

/// What `file` keeps; the default when there is no such file.
pub(crate) fn read<T: DeserializeOwned + Default>(file: &Path) -> Result<T> {
    match fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("{} is not what this keeps", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", file.display())),
    }
}

/// Keep `state` in `file`.
pub(crate) fn write<T: Serialize>(file: &Path, state: &T) -> Result<()> {
    write_private(file, &serde_json::to_vec_pretty(state)?)
}

/// Put `bytes` in `file`, readable by this user alone: written beside it and on the disk first,
/// then put in its place, so a crash leaves the old file or the new one, never half of one.
pub(crate) fn write_private(file: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = file.with_extension("tmp");
    // One left over would keep its own mode.
    let _ = fs::remove_file(&tmp);
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options
        .open(&tmp)
        .with_context(|| format!("cannot write {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(&tmp, file).with_context(|| format!("cannot write {}", file.display()))?;
    Ok(())
}

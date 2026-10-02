//! hivemind's phone core, as the iOS and Android apps call it (docs/design/phone-app-2026-10-02.md
//! §5): a UniFFI facade over `hive-phone`, from which Swift and Kotlin are generated
//! (`scripts/phone/bindings.sh`). It decides nothing the core does not: it hands the apps the
//! core's snapshots as records, and the core their calls.

use std::{future::Future, sync::LazyLock};

use tokio::runtime::{Builder, Runtime};

mod control;
mod error;
mod overview;
mod pairing;
mod phone;
mod records;
mod watch;

pub use control::{Diff, DiffFile, Frame, Start, StartOption, StartProgram, Startable};
pub use error::PhoneError;
pub use overview::{Following, OverviewListener};
pub use pairing::{pairs_with, PairsWith};
pub use phone::Phone;
pub use records::*;
pub use watch::{ScreenLine, ScreenListener, ScreenUpdate, Watch};

uniffi::setup_scaffolding!("hive_phone");

/// The runtime every call runs on, whichever platform's executor awaits it.
static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("hive-phone")
        .enable_all()
        .build()
        .expect("the phone's runtime")
});

/// `work`, run on the shared runtime.
async fn on_runtime<T: Send + 'static>(
    work: impl Future<Output = Result<T, PhoneError>> + Send + 'static,
) -> Result<T, PhoneError> {
    RUNTIME
        .spawn(work)
        .await
        .map_err(|e| PhoneError::Failed(e.to_string()))?
}

/// The core's version.
#[uniffi::export]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

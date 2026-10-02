//! What this device's servers and clients post to, and through what (R13, §12.4): a client that
//! trusts what this device's endpoint trusts (`net::trusted`), which a phone links too; and, on a
//! server, the push role's (`guarded`).

use std::sync::Arc;

use anyhow::Result;

#[cfg(feature = "server")]
mod guarded;
#[cfg(feature = "server")]
pub use guarded::Allowed;
#[cfg(feature = "server")]
pub(crate) use guarded::{guarded, may_post, upstream};

/// The TLS this device trusts; offering HTTP/2 first when `h2`.
fn tls(h2: bool) -> Result<rustls::ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut tls = crate::net::trusted().client_config(provider)?;
    if h2 {
        tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    }
    Ok(tls)
}

/// A client trusting what this device's endpoint trusts.
pub(crate) fn trusted() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls(false)?)
        .build()?)
}

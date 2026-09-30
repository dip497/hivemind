//! `hive-net doctor` (R16, §13.2): whether the network's servers answer this device, for Settings →
//! Network and `hive network doctor`. Each relay is tried alone, by an endpoint of this device that
//! knows only that relay, for a few seconds.

use std::time::Duration;

use iroh::{endpoint::presets, Endpoint, RelayMap, SecretKey};
use serde_json::{json, Value};

use crate::net::Reach;

/// How long a relay has to answer.
const WAIT: Duration = Duration::from_secs(8);

/// What answers, as JSON: `{"relays": [{"url", "ok"}], "mdns"}`.
pub async fn check(key: SecretKey, reach: &Reach) -> Value {
    let mut relays = vec![];
    for url in &reach.relays {
        let ok = match Endpoint::builder(presets::Minimal)
            .secret_key(key.clone())
            .relay_mode(iroh::endpoint::RelayMode::Custom(RelayMap::from(
                url.clone(),
            )))
            .bind()
            .await
        {
            Ok(endpoint) => {
                let online = tokio::time::timeout(WAIT, endpoint.online()).await.is_ok();
                endpoint.close().await;
                online
            }
            Err(_) => false,
        };
        relays.push(json!({ "url": url.to_string(), "ok": ok }));
    }
    json!({ "relays": relays, "mdns": reach.mdns })
}

//! `hive-net doctor` (R16, R13, §13.2): whether the network's servers answer this device, for
//! Settings → Network and `hive network doctor`. Each relay is tried alone, by an endpoint of this
//! device that knows only that relay, for a few seconds; one that refuses this device says why.
//! The lookup server and the access service are asked once each.

use std::time::Duration;

use iroh::{SecretKey, Watcher};
use serde_json::{json, Value};

use crate::net::{self, Reach};

/// How long a relay has to answer.
const WAIT: Duration = Duration::from_secs(8);

/// What answers, as JSON: `{"relays": [{"url", "ok", "refused"?}], "lookup": {"url", "ok"} | null,
/// "access": {"url", "ok"} | null, "mdns"}`.
pub async fn check(key: SecretKey, reach: &Reach, access: Option<String>) -> Value {
    let mut relays = vec![];
    for url in &reach.relays {
        let alone = Reach {
            relays: vec![url.clone()],
            lookup: None,
            mdns: false,
        };
        let mut answer = json!({ "url": url.to_string(), "ok": false });
        if let Ok(endpoint) = net::builder(key.clone(), &alone).bind().await {
            let online = tokio::time::timeout(WAIT, endpoint.online()).await.is_ok();
            answer["ok"] = online.into();
            if !online {
                let refused = endpoint
                    .home_relay_status()
                    .get()
                    .iter()
                    .find_map(|status| status.auth_denied_reason().map(str::to_string));
                if let Some(why) = refused {
                    answer["refused"] = why.into();
                }
            }
            endpoint.close().await;
        }
        relays.push(answer);
    }
    let http = crate::access::client::http().ok();
    // Whether `url` answers with success, or with `also`.
    let answers =
        |url: String, also: Option<u16>| {
            let http = http.clone();
            async move {
                match http {
                    Some(http) => http.get(&url).timeout(WAIT).send().await.is_ok_and(|r| {
                        r.status().is_success() || Some(r.status().as_u16()) == also
                    }),
                    None => false,
                }
            }
        };
    // The lookup server is asked for this device's own record: there or not, it answered.
    let lookup = match &reach.lookup {
        Some(url) => {
            let at = format!(
                "{}/{}",
                url.as_str().trim_end_matches('/'),
                key.public().to_z32()
            );
            json!({ "url": url.to_string(), "ok": answers(at, Some(404)).await })
        }
        None => Value::Null,
    };
    let access = match access {
        Some(url) => {
            let at = format!("{}/healthz", url.trim_end_matches('/'));
            json!({ "url": url, "ok": answers(at, None).await })
        }
        None => Value::Null,
    };
    json!({ "relays": relays, "lookup": lookup, "access": access, "mdns": reach.mdns })
}

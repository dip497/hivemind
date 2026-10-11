use std::str::FromStr;

use hive_net::{
    frames::{read_frame, write_frame},
    net::{addr_of, Reach},
};
use hive_phone::{
    agents, control, conversation, failure::Failure, network, pairing,
    workspace::{self, Reply},
};
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint, RelayUrl, SecretKey,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{e:#}"))
}

fn to_js(v: &Value) -> Result<JsValue, JsError> {
    js_sys::JSON::parse(&v.to_string()).map_err(|_| err("not JSON"))
}

fn from_js(v: &JsValue) -> Result<Value, JsError> {
    let text = js_sys::JSON::stringify(v).map_err(|_| err("not JSON"))?;
    serde_json::from_str(&String::from(text)).map_err(err)
}

/// The person's answer as the page gives it: `{text}`, `{allow}`, or `{approve, feedback?}`.
fn reply_of(said: &JsValue) -> Result<Reply, JsError> {
    let said = from_js(said)?;
    let text = |k: &str| said.get(k).and_then(Value::as_str).map(str::to_string);
    let yes = |k: &str| said.get(k).and_then(Value::as_bool);
    match (text("text"), yes("allow"), yes("approve")) {
        (Some(text), None, None) => Ok(Reply::Text(text)),
        (None, Some(allow), None) => Ok(Reply::Decide { allow }),
        (None, None, Some(approve)) => Ok(Reply::Plan {
            approve,
            feedback: text("feedback"),
        }),
        _ => Err(err("an answer is {text}, {allow} or {approve, feedback?}")),
    }
}

/// The device key whose seed is `seed`: the page keeps it (www/app/store.ts), this crate signs with it.
fn key_of(seed: &[u8]) -> Result<SecretKey, JsError> {
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| err("a device key is 32 bytes"))?;
    Ok(SecretKey::from_bytes(&seed))
}

/// Through `relays` alone: a browser has no local network to look on and sends no UDP.
fn through(relays: &[String]) -> Result<Reach, JsError> {
    let relays = relays
        .iter()
        .map(|r| RelayUrl::from_str(r))
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(Reach {
        relays,
        lookup: None,
        mdns: false,
    })
}

/// The id of the device whose key is `seed`.
#[wasm_bindgen(js_name = deviceId)]
pub fn device_id(seed: &[u8]) -> Result<String, JsError> {
    Ok(key_of(seed)?.public().to_string())
}

/// Pair the device `seed`, called `name`, with the app whose pairing `link` the person copied, as
/// the phone does (hive-phone's `Identity::pair_with`): onto the app's network as the link says,
/// then to the app through its relay. What pairing gave, `{with, certificate, network,
/// admission}`, for the page to keep; nothing is kept when it fails.
#[wasm_bindgen]
pub async fn pair(seed: Vec<u8>, link: String, name: String) -> Result<JsValue, JsError> {
    let key = key_of(&seed)?;
    let link = pairing::parse_link(&link).ok_or_else(|| {
        err(Failure::Invalid(
            "that is not a pairing link: copy it from Settings → Devices → Pair a phone".into(),
        ))
    })?;
    let relay = link.relay.clone().ok_or_else(|| {
        err(Failure::Unreachable(
            "that computer is on its local network alone, which a browser cannot reach: put it on a network with a relay"
                .into(),
        ))
    })?;
    let admission = match &link.admission {
        Some(admission) => network::admit(admission, &key)
            .await
            .map_err(|e| err(format!("not let onto the computer's network: {e:#}")))?,
        None => "none needed",
    };
    let endpoint = hive_net::net::endpoint(key, &through(&[relay])?, vec![])
        .await
        .map_err(err)?;
    let paired = pairing::pair(&endpoint, &name, &link).await;
    endpoint.close().await;
    let paired = paired.map_err(err)?;
    to_js(&json!({
        "with": paired.with,
        "certificate": paired.certificate,
        "network": paired.network,
        "admission": admission,
    }))
}

/// This browser as a device, reaching the person's others through relays alone.
#[wasm_bindgen]
pub struct Device {
    endpoint: Endpoint,
}

#[wasm_bindgen]
impl Device {
    /// The device whose key is `seed`, on `relays`.
    pub async fn start(seed: Vec<u8>, relays: Vec<String>) -> Result<Device, JsError> {
        let endpoint = hive_net::net::endpoint(key_of(&seed)?, &through(&relays)?, vec![])
            .await
            .map_err(err)?;
        Ok(Device { endpoint })
    }

    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Connect to the device `id` on `hive/ws/1`, through `relay`.
    pub async fn reach(&self, id: String, relay: Option<String>) -> Result<Host, JsError> {
        let at = addr_of(&id, &[], &relay).map_err(err)?;
        let connection = self
            .endpoint
            .connect(at, hive_net::ws::ALPN)
            .await
            .map_err(err)?;
        Ok(Host { connection })
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// A connection to one of the person's devices.
#[wasm_bindgen]
pub struct Host {
    connection: Connection,
}

#[wasm_bindgen]
impl Host {
    /// Follow every agent there (hive-phone's `agents::follow`): `listed` is called with
    /// `{agents, needs, working}` as each list comes, the phone's own order of what waits on the
    /// person. Done when the device ends it.
    pub async fn follow(&self, listed: js_sys::Function) -> Result<(), JsError> {
        let from = self.connection.remote_id().to_string();
        agents::follow(&self.connection, &from, |list| {
            let shown = serde_json::to_value(agents::as_one(vec![list])).unwrap_or(Value::Null);
            if let Ok(shown) = to_js(&shown) {
                let _ = listed.call1(&JsValue::NULL, &shown);
            }
        })
        .await
        .map_err(err)
    }

    /// Open the stream `name` (`sync`, `presence`, `api`, …), named in its first frame.
    pub async fn open(&self, name: String) -> Result<Stream, JsError> {
        let (send, recv) = hive_net::ws::open(&self.connection, &name)
            .await
            .map_err(err)?;
        Ok(Stream {
            send: Mutex::new(send),
            recv: Mutex::new(recv),
        })
    }

    /// Answer what the agent of `tile` in `workspace` waits on the person for, the wait that
    /// began at `since`, with `reply` (`{text}`, `{allow}` or `{approve, feedback?}`). Whether it
    /// landed: not when it waits on that no more.
    pub async fn answer(
        &self,
        workspace: String,
        tile: String,
        since: f64,
        reply: JsValue,
    ) -> Result<bool, JsError> {
        let reply = reply_of(&reply)?;
        workspace::answer(&self.connection, &workspace, &tile, since as u64, &reply)
            .await
            .map_err(err)
    }

    /// Send the agent of `tile` the message `text`, typed in once it is at its prompt. Whether it
    /// went: not when no agent runs there.
    pub async fn send(&self, workspace: String, tile: String, text: String) -> Result<bool, JsError> {
        workspace::send(&self.connection, &workspace, &tile, &text)
            .await
            .map_err(err)
    }

    /// Stop the agent of `tile` in its turn. Whether it was in one.
    pub async fn stop(&self, workspace: String, tile: String) -> Result<bool, JsError> {
        control::interrupt(&self.connection, &workspace, &tile)
            .await
            .map_err(err)
    }

    /// Close the agent of `tile`. Whether it was open.
    #[wasm_bindgen(js_name = closeAgent)]
    pub async fn close_agent(&self, workspace: String, tile: String) -> Result<bool, JsError> {
        control::close(&self.connection, &workspace, &tile)
            .await
            .map_err(err)
    }

    /// The agents `workspace` can start, and its frames: `{programs, frames}`.
    pub async fn startable(&self, workspace: String) -> Result<JsValue, JsError> {
        let startable = control::startable(&self.connection, &workspace)
            .await
            .map_err(err)?;
        to_js(&serde_json::to_value(startable).map_err(err)?)
    }

    /// Start an agent in `workspace`, `{program, frame?, prompt?, model?, mode?}`: its tile.
    pub async fn start(&self, workspace: String, start: JsValue) -> Result<String, JsError> {
        let start: control::Start = serde_json::from_value(from_js(&start)?).map_err(err)?;
        control::start(&self.connection, &workspace, &start)
            .await
            .map_err(err)
    }

    /// Follow what the agent of `tile` and the person said (hive-phone's `conversation::follow`):
    /// `said` is called with `{entries, cursor, session}` for each piece, in order and once, from
    /// the last of its session; until `until` settles or the device ends it.
    pub async fn conversation(
        &self,
        workspace: String,
        tile: String,
        said: js_sys::Function,
        until: js_sys::Promise,
    ) -> Result<(), JsError> {
        let followed = conversation::follow(&self.connection, &workspace, &tile, None, |piece| {
            let piece = json!({
                "entries": piece.entries,
                "cursor": piece.cursor,
                "session": piece.session,
            });
            if let Ok(piece) = to_js(&piece) {
                let _ = said.call1(&JsValue::NULL, &piece);
            }
        });
        let stopped = async {
            let _ = wasm_bindgen_futures::JsFuture::from(until).await;
            Ok(())
        };
        n0_future::future::or(followed, stopped).await.map_err(err)
    }

    pub fn close(&self) {
        self.connection.close(0u32.into(), b"closed");
    }
}

/// One named stream: frames each way, sent and received independently.
#[wasm_bindgen]
pub struct Stream {
    send: Mutex<SendStream>,
    recv: Mutex<RecvStream>,
}

#[wasm_bindgen]
impl Stream {
    pub async fn send(&self, frame: Vec<u8>) -> Result<(), JsError> {
        write_frame(&mut *self.send.lock().await, &frame)
            .await
            .map_err(err)
    }

    /// The next frame, or `undefined` once the host finished the stream.
    pub async fn recv(&self) -> Result<Option<Vec<u8>>, JsError> {
        read_frame(&mut *self.recv.lock().await).await.map_err(err)
    }
}

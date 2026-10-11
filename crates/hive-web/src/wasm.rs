use std::str::FromStr;

use iroh::{
    endpoint::{presets, Connection, ReadExactError, RecvStream, RelayMode, SendStream},
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayUrl, SecretKey,
};
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;

/// hive-net's `ws::ALPN`.
const ALPN: &[u8] = b"hive/ws/1";
/// hive-net's `frames::MAX_FRAME`.
const MAX_FRAME: usize = 64 * 1024 * 1024;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// This browser, as a device on one relay.
#[wasm_bindgen]
pub struct Device {
    endpoint: Endpoint,
    relay: RelayUrl,
}

#[wasm_bindgen]
impl Device {
    /// A device with a new key, reaching others through `relay` alone.
    pub async fn start(relay: String) -> Result<Device, JsError> {
        let relay = RelayUrl::from_str(&relay).map_err(err)?;
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .relay_mode(RelayMode::Custom(RelayMap::from_iter([relay.clone()])))
            .bind()
            .await
            .map_err(err)?;
        Ok(Device { endpoint, relay })
    }

    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Connect to the host `id` on `hive/ws/1`, through this device's relay.
    pub async fn dial(&self, id: String) -> Result<Host, JsError> {
        let id = EndpointId::from_str(&id).map_err(err)?;
        let to = EndpointAddr::new(id).with_relay_url(self.relay.clone());
        let connection = self.endpoint.connect(to, ALPN).await.map_err(err)?;
        Ok(Host { connection })
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

/// A connection to a host.
#[wasm_bindgen]
pub struct Host {
    connection: Connection,
}

#[wasm_bindgen]
impl Host {
    /// Open the stream `name` (`sync`, `presence`, `api`, …), named in its first frame.
    pub async fn open(&self, name: String) -> Result<Stream, JsError> {
        let (mut send, recv) = self.connection.open_bi().await.map_err(err)?;
        write_frame(&mut send, name.as_bytes()).await?;
        Ok(Stream {
            send: Mutex::new(send),
            recv: Mutex::new(recv),
        })
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
        write_frame(&mut *self.send.lock().await, &frame).await
    }

    /// The next frame, or `undefined` once the host finished the stream.
    pub async fn recv(&self) -> Result<Option<Vec<u8>>, JsError> {
        let mut recv = self.recv.lock().await;
        let mut len = [0u8; 4];
        match recv.read_exact(&mut len).await {
            Ok(()) => {}
            Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
            Err(e) => return Err(err(e)),
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > MAX_FRAME {
            return Err(err(format!("a frame of {len} bytes is over the limit")));
        }
        let mut frame = vec![0u8; len];
        recv.read_exact(&mut frame).await.map_err(err)?;
        Ok(Some(frame))
    }
}

/// One write per frame, as hive-net's `frames::write_frame`.
async fn write_frame(send: &mut SendStream, bytes: &[u8]) -> Result<(), JsError> {
    if bytes.len() > MAX_FRAME {
        return Err(err(format!(
            "a frame of {} bytes is over the limit",
            bytes.len()
        )));
    }
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(bytes);
    send.write_all(&frame).await.map_err(err)
}

//! `hive/ws/1` (design §7): a peer's connection to a workspace's host. It carries named streams:
//! the device that dialled opens each one, naming it in its first frame, and both sides then
//! send frames on it. What the frames mean is main's (`sync`, `presence`, `api`): hive-net only
//! carries them.

use anyhow::Result;
use iroh::endpoint::{Connection, RecvStream, SendStream};

use crate::frames::write_frame;

pub const ALPN: &[u8] = b"hive/ws/1";

/// Open the stream `name` on `connection`, which this device dialled: its frames go out on the
/// first half, and the other side's come back on the second.
pub async fn open(connection: &Connection, name: &str) -> Result<(SendStream, RecvStream)> {
    let (mut send, recv) = connection.open_bi().await?;
    write_frame(&mut send, name.as_bytes()).await?;
    Ok((send, recv))
}

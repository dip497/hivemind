//! Frames: a u32 big-endian length, then that many bytes. The local socket to main carries JSON
//! messages in them, and each QUIC stream between devices carries the bytes main sends.

use anyhow::{bail, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest frame either side accepts: a document snapshot fits; a runaway length does not.
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        bail!("a frame of {len} bytes is over the limit");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// `bytes` as a frame: its length, then it.
pub fn framed(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > MAX_FRAME {
        bail!("a frame of {} bytes is over the limit", bytes.len());
    }
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(bytes);
    Ok(frame)
}

/// One write per frame: on a QUIC stream each write can be a packet of its own.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> Result<()> {
    w.write_all(&framed(bytes)?).await?;
    w.flush().await?;
    Ok(())
}

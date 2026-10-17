use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use hive_net::frames::MAX_FRAME;

pub const OFFER: &str = "deflate";

pub fn unsqueezed(frame: Vec<u8>) -> Result<Vec<u8>> {
    let Some(packed) = frame.strip_prefix(b"z:") else {
        return Ok(frame);
    };
    let deflated = STANDARD.decode(packed).context("a deflated frame that is not base64")?;
    miniz_oxide::inflate::decompress_to_vec_with_limit(&deflated, MAX_FRAME)
        .map_err(|e| anyhow::anyhow!("a deflated frame that does not inflate: {e:?}"))
}

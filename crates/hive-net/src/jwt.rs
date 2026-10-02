//! JSON Web Tokens this server signs (RFC 7519): the provider token Apple's push service takes
//! (ES256), the assertion Google exchanges for an access token (RS256), and the VAPID token a
//! UnifiedPush distributor may ask for (RFC 8292, ES256); and the PEM files their keys come in.

use anyhow::{Context, Result};
use base64::Engine;
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde_json::Value;

pub(crate) fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The DER inside a PEM file.
pub(crate) fn pem_der(pem: &str) -> Result<Vec<u8>> {
    let inner: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .map(str::trim)
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(inner)
        .context("not a PEM key")
}

/// A token of `header` and `claims`, signed by `sign`.
fn token(
    header: &Value,
    claims: &Value,
    sign: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<String> {
    let input = format!(
        "{}.{}",
        b64url(header.to_string().as_bytes()),
        b64url(claims.to_string().as_bytes())
    );
    let signature = sign(input.as_bytes())?;
    Ok(format!("{input}.{}", b64url(&signature)))
}

/// A token signed with the P-256 key `key` (ES256: the signature is r and s, 32 bytes each).
pub(crate) fn es256(key: &EcdsaKeyPair, header: &Value, claims: &Value) -> Result<String> {
    token(header, claims, |input| {
        Ok(key
            .sign(&SystemRandom::new(), input)
            .map_err(|_| anyhow::anyhow!("could not sign the token"))?
            .as_ref()
            .to_vec())
    })
}

/// A token signed with the RSA key `key` (RS256).
pub(crate) fn rs256(key: &RsaKeyPair, header: &Value, claims: &Value) -> Result<String> {
    token(header, claims, |input| {
        let mut signature = vec![0; key.public().modulus_len()];
        key.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            input,
            &mut signature,
        )
        .map_err(|_| anyhow::anyhow!("could not sign the token"))?;
        Ok(signature)
    })
}

/// A token's header and claims, what it signs, and its signature: a test reads one back so.
#[cfg(test)]
pub(crate) fn parts(token: &str) -> (Value, Value, Vec<u8>, Vec<u8>) {
    let unb64 = |s: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .unwrap()
    };
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "{token}");
    (
        serde_json::from_slice(&unb64(parts[0])).unwrap(),
        serde_json::from_slice(&unb64(parts[1])).unwrap(),
        format!("{}.{}", parts[0], parts[1]).into_bytes(),
        unb64(parts[2]),
    )
}

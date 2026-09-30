//! `hive/pair/1` (design §7): first contact. Someone new presents what they were given (an invite's
//! secret, with their device certificate and profile) and the host answers (a role, or no). Open
//! to any device: the host's main decides, and the connection closes after the answer.

pub const ALPN: &[u8] = b"hive/pair/1";

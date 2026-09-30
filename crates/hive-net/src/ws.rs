//! `hive/ws/1` (design §7): a peer's connection to a workspace's host. It carries named streams:
//! the device that dialled opens each one, naming it in its first frame, and both sides then
//! send frames on it. What the frames mean is main's (`sync`, `presence`, `api`): hive-net only
//! carries them.

pub const ALPN: &[u8] = b"hive/ws/1";

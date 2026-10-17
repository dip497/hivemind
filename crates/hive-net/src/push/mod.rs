//! The push role (design §12.4, spec/push.md 0.3): how a phone that cannot be reached at an
//! address of its own is told what happens on the person's devices. A phone registers, proving its
//! device key and naming the devices that may tell it (`wire`, `client`), and is given a handle;
//! those devices post their notices, encrypted to the phone (Web Push) and signed with their device
//! key, to the handle's address; and the role (`service`) passes each on, unread, to where the
//! phone said. It keeps the phones' registrations and nothing of what it passes on. A phone links
//! its own side alone: the role is a server's (the `server` feature).

pub mod client;
mod wire;
pub use wire::Platform;

#[cfg(feature = "server")]
mod apns;
#[cfg(feature = "server")]
mod fcm;
#[cfg(feature = "server")]
mod posted;
#[cfg(feature = "server")]
mod service;
#[cfg(feature = "server")]
mod store;
#[cfg(feature = "server")]
mod unifiedpush;
#[cfg(feature = "server")]
pub use {
    apns::Apns,
    fcm::Fcm,
    service::{Options, Service},
};

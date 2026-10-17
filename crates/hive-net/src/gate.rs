//! The gate (design §7, R11): which devices may connect to this one. Main gives the devices its
//! access lists admit; any other device is refused on every protocol but pairing and ping, which
//! are how someone new first reaches a host and how anyone checks a device answers. A device
//! taken off the list loses its connections at once.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use iroh::{
    endpoint::{AfterHandshakeOutcome, Connection, EndpointHooks, Side, WeakConnectionHandle},
    EndpointId,
};

use crate::{pair, ping};

/// Why a connection was refused or closed, as the other side reads it.
pub const NOT_ADMITTED: u32 = 403;

#[derive(Debug, Default, Clone)]
pub struct Gate {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Debug, Default)]
struct Inner {
    admitted: HashSet<EndpointId>,
    live: Vec<(EndpointId, WeakConnectionHandle)>,
}

impl Gate {
    /// Admit exactly `devices` from now on, and close every connection of a device no longer among them.
    pub fn admit(&self, devices: HashSet<EndpointId>) {
        let mut inner = self.inner.lock().unwrap();
        inner.admitted = devices;
        let Inner { admitted, live } = &mut *inner;
        live.retain(|(id, handle)| match handle.upgrade() {
            Some(conn) if !admitted.contains(id) => {
                conn.close(NOT_ADMITTED.into(), b"removed");
                false
            }
            Some(_) => true,
            None => false,
        });
    }
}

impl EndpointHooks for Gate {
    async fn after_handshake<'a>(&'a self, conn: &'a Connection) -> AfterHandshakeOutcome {
        // A connection this device made is to someone it chose to reach.
        if conn.side() == Side::Client {
            return AfterHandshakeOutcome::accept();
        }
        let alpn = conn.alpn();
        if alpn == pair::ALPN || alpn == ping::ALPN {
            return AfterHandshakeOutcome::accept();
        }
        let id = conn.remote_id();
        let mut inner = self.inner.lock().unwrap();
        if !inner.admitted.contains(&id) {
            return AfterHandshakeOutcome::Reject {
                error_code: NOT_ADMITTED.into(),
                reason: b"not admitted".to_vec(),
            };
        }
        inner.live.push((id, conn.weak_handle()));
        AfterHandshakeOutcome::accept()
    }
}

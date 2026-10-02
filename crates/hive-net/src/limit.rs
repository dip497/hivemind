//! Holding back what one source sends a server role (R13, §12.4): a bucket of tokens per source,
//! refilled at a steady rate, each request taking one. A source is an address (an IPv6 address by
//! its /64, which a network is given whole) or whatever else a role counts by: a phone, say.

use std::{
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, Ipv6Addr},
    sync::Mutex,
    time::{Duration, Instant},
};

/// What holds back one kind of request: each source may make `burst` at once, then one more every
/// `every`; past `most` sources, those whose buckets are full again are forgotten.
#[derive(Debug)]
pub struct Limit<K> {
    burst: f64,
    every: Duration,
    most: usize,
    buckets: Mutex<HashMap<K, (f64, Instant)>>,
}

impl<K: Hash + Eq> Limit<K> {
    pub fn new(burst: u32, every: Duration, most: usize) -> Self {
        Self {
            burst: burst.into(),
            every,
            most,
            buckets: Mutex::default(),
        }
    }

    /// Whether `source` may make one more request now; when it may, this one is counted.
    pub fn allow(&self, source: K) -> bool {
        let now = Instant::now();
        let refill = |tokens: f64, at: Instant| {
            (tokens + now.duration_since(at).as_secs_f64() / self.every.as_secs_f64())
                .min(self.burst)
        };
        let mut buckets = self.buckets.lock().unwrap();
        if buckets.len() > self.most {
            buckets.retain(|_, (tokens, at)| refill(*tokens, *at) < self.burst);
        }
        let (tokens, at) = buckets.entry(source).or_insert((self.burst, now));
        *tokens = refill(*tokens, *at);
        *at = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// The source `ip` counts as: itself, or an IPv6 address's /64.
pub fn source(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_makes_its_burst_then_one_more_as_its_bucket_fills_and_others_are_counted_apart() {
        let limit = Limit::new(3, Duration::from_millis(200), 100);
        assert!((0..3).all(|_| limit.allow("a")));
        assert!(!limit.allow("a"));
        assert!(limit.allow("b"));
        std::thread::sleep(Duration::from_millis(220));
        assert!(limit.allow("a"));
        assert!(!limit.allow("a"));
    }

    #[test]
    fn an_ipv6_address_counts_as_its_64_and_an_ipv4_one_as_itself() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:bbbb::2".parse().unwrap();
        let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(source(a), source(b));
        assert_ne!(source(a), source(c));
        let v4: IpAddr = "192.0.2.7".parse().unwrap();
        assert_eq!(source(v4), v4);
        assert_eq!(source("::ffff:192.0.2.7".parse().unwrap()), v4);
    }
}

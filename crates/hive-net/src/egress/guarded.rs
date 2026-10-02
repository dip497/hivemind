//! The push role's clients (§12.4): one for the push services of the phones' makers (Apple's,
//! Google's), keeping its HTTP/2 connection as they ask; and one for the addresses phones give
//! themselves (a UnifiedPush distributor's), which reaches none on this server's own networks but
//! those it is allowed to (`Allowed`), through no proxy (a proxy would look the name up itself) and
//! following no redirect.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use anyhow::{ensure, Context, Result};

use super::tls;

/// For Apple's and Google's push services: HTTP/2 (Apple's speaks nothing else), its connection
/// kept, and pinged hourly while idle, as Apple asks; following no redirect.
pub(crate) fn upstream() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls(true)?)
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(None)
        .http2_keep_alive_interval(Duration::from_secs(60 * 60))
        .http2_keep_alive_while_idle(true)
        .build()?)
}

/// For the addresses phones give: public ones, and those on the networks `allowed`; through no
/// proxy, following no redirect.
pub(crate) fn guarded(allowed: Allowed) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .tls_backend_preconfigured(tls(true)?)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .dns_resolver(Arc::new(Guarded(allowed)))
        .build()?)
}

/// The networks of this server's own that a phone may be told at (`--push-allow`, a building's
/// say): none unless named.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Allowed(Vec<(IpAddr, u8)>);

impl Allowed {
    /// From networks such as `192.168.1.0/24` (an address alone is a network of one).
    pub fn parse(networks: &[String]) -> Result<Self> {
        networks
            .iter()
            .map(|n| {
                let (ip, bits) = n.split_once('/').unwrap_or((n, ""));
                let ip = IpAddr::from_str(ip).with_context(|| format!("{n} is not a network"))?;
                let most = if ip.is_ipv4() { 32 } else { 128 };
                let bits = if bits.is_empty() {
                    most
                } else {
                    bits.parse()
                        .with_context(|| format!("{n} is not a network"))?
                };
                ensure!(bits <= most, "{n} is not a network");
                Ok((ip, bits))
            })
            .collect::<Result<_>>()
            .map(Self)
    }

    /// Whether any network is.
    fn any(&self) -> bool {
        !self.0.is_empty()
    }

    /// Whether `ip` is on one of them.
    pub(crate) fn permits(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.0
            .iter()
            .any(|(net, bits)| match (canonical(*net), ip) {
                (IpAddr::V4(net), IpAddr::V4(ip)) => {
                    let mask = u32::MAX.checked_shl(32 - u32::from(*bits)).unwrap_or(0);
                    u32::from(net) & mask == u32::from(ip) & mask
                }
                (IpAddr::V6(net), IpAddr::V6(ip)) => {
                    let mask = u128::MAX.checked_shl(128 - u32::from(*bits)).unwrap_or(0);
                    u128::from(net) & mask == u128::from(ip) & mask
                }
                _ => false,
            })
    }
}

/// `ip`, an IPv4 address written as IPv6 read as the IPv4 address it is.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

/// Whether `ip` is on the public internet: not this machine, nor a private, shared, link-local or
/// unique-local network, nor an address set aside (documentation, benchmarking, multicast,
/// reserved); an IPv4 address carried in IPv6 (mapped, NAT64, 6to4) as that address is.
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..128).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..32).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && (c == 0 || c == 2))
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            let v4 = |hi: u16, lo: u16| {
                let [a, b] = hi.to_be_bytes();
                let [c, d] = lo.to_be_bytes();
                public(IpAddr::V4(Ipv4Addr::new(a, b, c, d)))
            };
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return public(IpAddr::V4(mapped));
            }
            // NAT64's well-known prefix, and 6to4.
            if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return v4(s[6], s[7]);
            }
            if s[0] == 0x2002 {
                return v4(s[1], s[2]);
            }
            !(s[..6] == [0; 6]
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] & 0xffc0) == 0xfec0
                || (s[0] & 0xff00) == 0xff00
                || s[..3] == [0x64, 0xff9b, 1]
                || s[..4] == [0x100, 0, 0, 0]
                || s[..3] == [0x2001, 2, 0]
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || (s[0] == 0x3fff && s[1] < 0x1000)
                || s[0] == 0x5f00)
        }
    }
}

/// Whether a phone may be told at `url`: over https at an address on the internet, or at one on
/// the networks `allowed` (over http too). A name is checked as it is looked up (`Guarded`).
pub(crate) fn may_post(url: &url::Url, allowed: &Allowed) -> Result<()> {
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "a UnifiedPush token is an http or https address"
    );
    let ip = match url.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            (name == "localhost" || name.ends_with(".localhost"))
                .then_some(IpAddr::V4(Ipv4Addr::LOCALHOST))
        }
        None => anyhow::bail!("{url} names no server"),
    };
    let ours = match ip {
        Some(ip) if allowed.permits(ip) => true,
        Some(ip) => {
            ensure!(
                public(ip),
                "{url} is not on the public internet, nor on a network this push server serves"
            );
            false
        }
        None => allowed.any(),
    };
    ensure!(
        ours || url.scheme() == "https",
        "{url}: a distributor on the internet is reached over https"
    );
    Ok(())
}

/// Names looked up as anyone's, answered with the addresses a phone may be told at alone: public
/// ones, and those on the networks allowed.
struct Guarded(Allowed);

impl reqwest::dns::Resolve for Guarded {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let allowed = self.0.clone();
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| public(a.ip()) || allowed.permits(a.ip()))
                .collect();
            if found.is_empty() {
                return Err(format!(
                    "{host} is not on the public internet, nor on a network this push server serves"
                )
                .into());
            }
            Ok(Box::new(found.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::dns::Resolve;

    #[test]
    fn an_address_on_this_machine_or_a_private_shared_link_local_or_set_aside_network_is_not_public(
    ) {
        for (ip, outside) in [
            ("8.8.8.8", true),
            ("1.1.1.1", true),
            ("172.32.0.1", true),
            ("100.128.0.1", true),
            ("2606:4700:4700::1111", true),
            ("::ffff:8.8.8.8", true),
            ("64:ff9b::808:808", true),
            ("2002:808:808::1", true),
            ("0.0.0.0", false),
            ("127.0.0.1", false),
            ("127.1.2.3", false),
            ("10.1.2.3", false),
            ("172.16.0.1", false),
            ("172.31.255.255", false),
            ("192.168.1.10", false),
            ("169.254.169.254", false),
            ("100.64.0.1", false),
            ("192.0.2.1", false),
            ("198.18.0.1", false),
            ("198.51.100.7", false),
            ("203.0.113.9", false),
            ("224.0.0.1", false),
            ("255.255.255.255", false),
            ("::", false),
            ("::1", false),
            ("::127.0.0.1", false),
            ("::ffff:127.0.0.1", false),
            ("::ffff:10.0.0.1", false),
            ("64:ff9b::7f00:1", false),
            ("64:ff9b:1::1", false),
            ("2002:7f00:1::1", false),
            ("2002:a9fe:a9fe::1", false),
            ("fc00::1", false),
            ("fd12:3456::1", false),
            ("fe80::1", false),
            ("fec0::1", false),
            ("ff02::1", false),
            ("2001:db8::1", false),
            ("2001:2::1", false),
            ("3fff::1", false),
            ("3fff:1000::1", true),
            ("5f00::1", false),
            ("100::1", false),
        ] {
            assert_eq!(public(ip.parse().unwrap()), outside, "{ip}");
        }
    }

    #[test]
    fn networks_allowed_are_the_ones_named_and_an_address_alone_is_a_network_of_one() {
        let allowed = Allowed::parse(&[
            "192.168.1.0/24".into(),
            "fd00::/8".into(),
            "10.0.0.7".into(),
        ])
        .unwrap();
        for (ip, on) in [
            ("192.168.1.200", true),
            ("::ffff:192.168.1.200", true),
            ("192.168.2.1", false),
            ("fd12::1", true),
            ("fe80::1", false),
            ("10.0.0.7", true),
            ("10.0.0.8", false),
        ] {
            assert_eq!(allowed.permits(ip.parse().unwrap()), on, "{ip}");
        }
        assert!(Allowed::parse(&["0.0.0.0/0".into()])
            .unwrap()
            .permits("8.8.8.8".parse().unwrap()));
        assert!(!Allowed::default().permits("127.0.0.1".parse().unwrap()));
        for bad in ["192.168.1.0/33", "fd00::/129", "a network", "10.0.0.0/x"] {
            assert!(Allowed::parse(&[bad.into()]).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_distributor_is_posted_to_over_https_on_the_internet_or_on_a_network_allowed() {
        let none = Allowed::default();
        let loopback = Allowed::parse(&["127.0.0.0/8".into()]).unwrap();
        let may = |url: &str, allowed: &Allowed| {
            may_post(&url::Url::parse(url).unwrap(), allowed).is_ok()
        };
        for url in [
            "http://127.0.0.1:8080/up",
            "https://127.0.0.1:8080/up",
            "http://localhost:8080/up",
            "https://LocalHost./up",
            "https://ntfy.localhost/up",
        ] {
            assert!(!may(url, &none), "{url}");
            assert!(may(url, &loopback), "{url}");
        }
        for url in [
            "https://[::1]/up",
            "https://10.0.0.5/up",
            "https://169.254.169.254/latest/meta-data",
        ] {
            assert!(!may(url, &none), "{url}");
            assert!(!may(url, &loopback), "{url}");
        }
        assert!(may("https://ntfy.example.org/up/1", &none));
        assert!(may("https://93.184.215.14/up", &none));
        assert!(!may("http://ntfy.example.org/up/1", &none));
        assert!(!may("http://93.184.215.14/up", &none));
        assert!(may("http://ntfy.lan/up/1", &loopback));
        assert!(!may("ftp://ntfy.example.org/up", &loopback));
        assert!(!may("file:///etc/passwd", &loopback));
    }

    #[tokio::test]
    async fn a_name_on_this_machine_is_looked_up_to_no_address_unless_its_network_is_allowed() {
        let localhost = || "localhost".parse().unwrap();
        assert!(Guarded(Allowed::default())
            .resolve(localhost())
            .await
            .is_err());
        let allowed = Allowed::parse(&["127.0.0.0/8".into(), "::1".into()]).unwrap();
        let found: Vec<_> = Guarded(allowed)
            .resolve(localhost())
            .await
            .unwrap()
            .collect();
        assert!(
            !found.is_empty() && found.iter().all(|a| a.ip().is_loopback()),
            "{found:?}"
        );
    }
}

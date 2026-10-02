//! What a scanned pairing link says before the phone pairs with it
//! (docs/design/phone-app-2026-10-02.md §5.1): the device it pairs with, which the app names while
//! pairing runs.

use hive_phone::pairing;

use crate::records::DeviceKind;

/// The device a pairing link pairs with: its id, its name and its kind.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PairsWith {
    pub device: String,
    pub name: String,
    pub kind: DeviceKind,
}

/// The device `link`, a scanned QR code's text, pairs with; none when it is no pairing link.
#[uniffi::export]
pub fn pairs_with(link: String) -> Option<PairsWith> {
    pairing::parse_link(&link).map(|link| PairsWith {
        device: link.device,
        name: link.name,
        kind: DeviceKind::named(&link.kind),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// The text of conformance/pairing.json's link case `about`.
    fn link(about: &str) -> String {
        let cases: Value =
            serde_json::from_str(include_str!("../../../conformance/pairing.json")).unwrap();
        let case = cases["link"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["about"] == about)
            .unwrap();
        case["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_link_names_the_device_it_pairs_with_before_pairing_and_anything_else_names_none() {
        let device = "c7b697b92fc63a2dd660f6f02f2ce32eb4a842839cbe4213845e3b4390f446c3";
        assert_eq!(
            pairs_with(link("an app's link")),
            Some(PairsWith {
                device: device.into(),
                name: "Priya's desktop".into(),
                kind: DeviceKind::Computer,
            })
        );
        let host = pairs_with(link("a host's, through a relay")).unwrap();
        assert_eq!(
            (host.name.as_str(), host.kind),
            ("home-server", DeviceKind::Host)
        );
        assert_eq!(pairs_with(link("not a pairing link")), None);
    }
}

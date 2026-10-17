use hive_phone::squeeze::{unsqueezed, OFFER};
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("../../../conformance/squeeze.json")).unwrap()
}

#[test]
fn a_deflated_frame_reads_as_the_text_the_device_meant_and_any_other_as_it_is() {
    let c = cases();
    assert_eq!(c["offer"], OFFER);
    for case in c["squeezed"].as_array().unwrap() {
        let read = unsqueezed(case["frame"].as_str().unwrap().as_bytes().to_vec()).unwrap();
        assert_eq!(String::from_utf8(read).unwrap(), case["text"].as_str().unwrap(), "{}", case["name"]);
    }
    for case in c["plain"].as_array().unwrap() {
        let frame = case["frame"].as_str().unwrap().as_bytes().to_vec();
        assert_eq!(unsqueezed(frame.clone()).unwrap(), frame, "{}", case["name"]);
    }
}

#[test]
fn a_frame_that_says_it_is_deflated_and_is_not_is_refused() {
    for case in cases()["refused"].as_array().unwrap() {
        let frame = case["frame"].as_str().unwrap().as_bytes().to_vec();
        assert!(unsqueezed(frame).is_err(), "{}", case["name"]);
    }
}

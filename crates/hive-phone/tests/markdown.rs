//! What an agent says, read as spec/markdown.md says, held to conformance/markdown.json: each
//! case's markdown read to its blocks, exactly as the JSON the apps are handed.

use hive_phone::markdown::read;
use serde_json::Value;

#[test]
fn what_an_agent_says_is_read_to_the_blocks_the_spec_gives() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../conformance/markdown.json")).unwrap();
    let cases = cases["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    let mut failed = Vec::new();
    for c in cases {
        let expected = &c["blocks"];
        let read = serde_json::to_value(read(c["markdown"].as_str().unwrap())).unwrap();
        if &read != expected {
            failed.push(format!(
                "{}\n  read     {}\n  expected {}",
                c["about"],
                serde_json::to_string(&read).unwrap(),
                serde_json::to_string(&expected).unwrap()
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} of {} cases:\n{}",
        failed.len(),
        cases.len(),
        failed.join("\n")
    );
}

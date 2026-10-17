//! The View menu's rules (`hive_phone::layers`) held to conformance/layers.json, which the
//! desktop's rules (packages/hive-core/src/layers.ts) are held to too.

use hive_phone::layers::{view, LayerTile, Prefs};
use serde_json::{json, Value};

#[test]
fn the_same_tiles_and_choices_give_the_lists_the_desktop_gives() {
    let file: Value =
        serde_json::from_str(include_str!("../../../conformance/layers.json")).unwrap();
    let tiles: Vec<LayerTile> = serde_json::from_value(file["tiles"].clone()).unwrap();
    let now = file["now"].as_u64().unwrap();
    let label = |t: &LayerTile| file["label"][&t.id].as_str().unwrap().to_string();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let mut prefs = serde_json::to_value(Prefs::default()).unwrap();
        for (k, v) in c["prefs"].as_object().unwrap() {
            prefs[k] = v.clone();
        }
        let prefs: Prefs = serde_json::from_value(prefs).unwrap();
        let pinned: Vec<String> =
            serde_json::from_value(c.get("pinned").cloned().unwrap_or(json!([]))).unwrap();
        let v = view(
            &tiles,
            &pinned,
            &prefs,
            now,
            0,
            &label,
            c["query"].as_str().unwrap_or(""),
        );
        let ids = |l: &[usize]| l.iter().map(|&i| tiles[i].id.clone()).collect::<Vec<_>>();
        let shows = json!({
            "pinned": ids(&v.pinned),
            "tree": v.tree,
            "byFrame": v.by_frame.iter().map(|(f, l)| json!([f, ids(l)])).collect::<Vec<_>>(),
            "buckets": v.buckets.iter().map(|b| json!({ "key": b.key, "label": b.label, "tiles": ids(&b.tiles) })).collect::<Vec<_>>(),
            "filtering": v.filtering,
            "kids": v.kids.iter().map(|(p, l)| json!([p, ids(l)])).collect::<Vec<_>>(),
        });
        assert_eq!(shows, c["shows"], "{}", c["about"]);
    }
}

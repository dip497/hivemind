// The hosted network's layout (R13, §12.1, §12.3): relays on machines of their own, each asking
// the network's access service about every device that connects (`serve --relay --access-url`).
// A device the service has not let in is refused, and told why; let in, it gets in within
// seconds; and while the service does not answer, the relay still admits the devices it was told
// about, however long ago, and no one else.

mod support;

use std::{fs, time::Duration};

use serde_json::Value;
use support::*;

#[test]
fn a_relay_apart_from_the_access_service_admits_whom_it_says_and_rides_out_its_outage() {
    let root = temp("relays-apart");
    let admin = root.join("admin.key");
    fs::write(&admin, format!("{}\n", "c3".repeat(32))).unwrap();
    let (laptop, laptop_id) = device(&root, "laptop");
    let (stranger, _) = device(&root, "stranger");
    let voucher = String::from_utf8(
        hive_net(
            &[
                "access",
                "voucher",
                "--kind",
                "enrol",
                "--admin",
                admin.to_str().unwrap(),
                "--device",
                &laptop_id,
            ],
            &[],
        )
        .stdout,
    )
    .unwrap();
    let admin_id = serde_json::from_str::<Value>(&voucher).unwrap()["by"]
        .as_str()
        .unwrap()
        .to_string();
    let access_server = start(
        &[
            "serve",
            "--access",
            "--admin-id",
            &admin_id,
            "--data",
            root.join("access").to_str().unwrap(),
            "--bind",
            "127.0.0.1:0",
        ],
        &[],
    );
    let access = access_server.after("access serving on ");
    // Two relays asking it: one keeping a yes as long as it does by default, one for a second.
    let relay = |cache: Option<&str>| {
        let mut args = vec!["serve", "--relay", "--access-url", &access];
        if let Some(seconds) = cache {
            args.extend(["--access-cache", seconds]);
        }
        args.extend(["--bind", "127.0.0.1:0"]);
        let server = start(&args, &[]);
        let url = server.after("relay serving on ");
        (server, url)
    };
    let (_relay, usual) = relay(None);
    let (_brief, brief) = relay(Some("1"));
    let on = |relay: &str, who: &str| -> Value {
        let out = hive_net(&["doctor", "--identity", who, "--relay", relay], &[]);
        let report: Value = serde_json::from_slice(&out.stdout).unwrap();
        report["relays"][0].clone()
    };

    // Not let in: refused, and told why.
    let before = on(&usual, &laptop);
    assert_eq!(before["ok"], false, "{before}");
    assert!(before["refused"].is_string(), "{before}");
    // Let in: in, within seconds, though the relay was told no a moment ago.
    let out = hive_net(&["access", "vouch", &access, voucher.trim()], &[]);
    assert!(out.status.success(), "{}", text(&out));
    assert!(
        eventually(Duration::from_secs(30), || on(&usual, &laptop)["ok"]
            == true),
        "still turned away after it was let in"
    );

    // The access service goes: the device it let in still gets in, though the relay's yes is
    // old and it cannot ask again; and nobody else does.
    assert_eq!(on(&brief, &laptop)["ok"], true);
    drop(access_server);
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(on(&brief, &laptop)["ok"], true, "locked out by an outage");
    assert_eq!(
        on(&brief, &stranger)["ok"],
        false,
        "let in with nobody asked"
    );
    fs::remove_dir_all(root).unwrap();
}

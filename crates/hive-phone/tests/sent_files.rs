//! Files an agent sent the phone (sent_files.rs, spec/sent-files.md): the list followed, leaving out
//! what a phone does not take; each file fetched exactly in pieces; and a fetch cut off goes on from
//! where it stopped, on the next connection, asking for nothing twice.

mod support;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use hive_phone::{
    connections::Connections,
    sent_files::{self, read_files, SentFile, FILE_MAX},
};
use serde_json::json;
use support::{paired_with, tmp, until, Desk, TILE, WORKSPACE};

const ID: &str = "0123456789abcdef0123456789abcdef";

fn file(name: &str, size: u64) -> serde_json::Value {
    json!({ "id": ID, "tile": TILE, "name": name, "size": size, "type": "application/pdf", "at": 5 })
}

#[test]
fn a_file_with_a_folder_in_its_name_a_bad_id_or_more_than_a_phone_takes_is_left_out() {
    let files = json!([
        file("report.pdf", 10),
        file("../../etc/passwd", 10),
        file("a\\b.exe", 10),
        file("", 10),
        file(&"x".repeat(201), 10),
        file("big.bin", FILE_MAX + 1),
        { "id": "../secret", "name": "a", "size": 1, "type": "t", "at": 1 },
        { "name": "no id" },
    ]);
    let read = read_files(&files);
    assert_eq!(
        read,
        vec![SentFile {
            id: ID.into(),
            name: "report.pdf".into(),
            size: 10,
            mime: "application/pdf".into(),
            at: 5
        }]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fetch_cut_off_part_way_goes_on_from_where_it_stopped_and_the_file_comes_exactly() {
    let desk = Desk::start(71).await;
    let bytes: Vec<u8> = (0..5000u32).map(|i| (i * 31) as u8).collect();
    *desk.sent_bytes.lock().unwrap() = bytes.clone();
    let phone = paired_with(&tmp("sent-files-resume"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let size = bytes.len() as u64;

    let mut had = Vec::new();
    let connection = connections.holding(&desk.id, WORKSPACE).await.unwrap();
    let cut = sent_files::fetch(&connection, WORKSPACE, ID, size, 0, |piece| {
        had.extend_from_slice(&piece);
        if had.len() == 2048 {
            desk.drop_connections();
        }
    })
    .await;
    assert!(cut.is_err(), "{cut:?}");
    assert_eq!(had.len(), 2048, "what came before the cut is kept");

    // The phone reaches the device again in its own time, as it does after any drop.
    let mut connection = None;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let Ok(now) = connections.holding(&desk.id, WORKSPACE).await else {
            continue;
        };
        let from = had.len() as u64;
        let fetched = sent_files::fetch(&now, WORKSPACE, ID, size, from, |piece| {
            had.extend_from_slice(&piece);
        })
        .await;
        if fetched.is_ok() {
            connection = Some(now);
            break;
        }
    }
    let connection = connection.expect("reached again");
    assert_eq!(had, bytes);
    assert_eq!(
        *desk.sent_asked.lock().unwrap(),
        vec![0, 1024, 2048, 3072, 4096],
        "nothing is asked for twice, and the next piece not before it is needed"
    );

    let mut more = 0;
    sent_files::fetch(&connection, WORKSPACE, ID, size, size, |_| more += 1)
        .await
        .unwrap();
    assert_eq!(more, 0, "all of it had, nothing is asked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_that_says_another_size_is_not_believed_and_more_than_a_phone_takes_is_not_asked()
{
    let desk = Desk::start(72).await;
    *desk.sent_bytes.lock().unwrap() = vec![1; 100];
    let phone = paired_with(&tmp("sent-files-size"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let connection = connections.holding(&desk.id, WORKSPACE).await.unwrap();
    let mut had = 0;
    let changed = sent_files::fetch(&connection, WORKSPACE, ID, 200, 0, |p| had += p.len()).await;
    assert!(changed.is_err());
    assert_eq!(had, 0, "nothing of a file that changed is kept");
    let big = sent_files::fetch(&connection, WORKSPACE, ID, FILE_MAX + 1, 0, |_| {}).await;
    assert!(big.is_err());
    assert_eq!(desk.sent_asked.lock().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_list_comes_as_it_stands_then_whole_as_it_changes_of_this_agent_alone() {
    let desk = Desk::start(73).await;
    desk.sent_files.send_replace(json!([file("a.pdf", 1)]));
    let phone = paired_with(&tmp("sent-files-list"), &desk);
    let connections = Connections::new(phone.clone(), || {});
    connections.foreground();
    let connection = connections.holding(&desk.id, WORKSPACE).await.unwrap();
    let lists: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let heard = lists.clone();
    let following = tokio::spawn(async move {
        sent_files::follow(&connection, WORKSPACE, TILE, |files| {
            heard
                .lock()
                .unwrap()
                .push(files.into_iter().map(|f| f.name).collect());
        })
        .await
    });
    assert!(until(Duration::from_secs(10), || lists.lock().unwrap().len() == 1).await);
    desk.sent_files.send_replace(json!([file("b.pdf", 2)]));
    assert!(until(Duration::from_secs(10), || lists.lock().unwrap().len() == 2).await);
    assert_eq!(
        *lists.lock().unwrap(),
        vec![vec!["a.pdf".to_string()], vec!["b.pdf".to_string()]]
    );
    following.abort();
}

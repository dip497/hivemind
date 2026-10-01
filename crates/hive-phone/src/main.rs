//! `hive-phone`: in a terminal, what the phone does (M5).
//!
//!   hive-phone id               print this phone's id (its device key's public half)
//!   hive-phone pair <link>      pair with the app that shows this link (Settings → Devices on a
//!                               computer): this phone is that app's person from then on
//!   hive-phone devices          the person's devices this phone paired with
//!   hive-phone needs            what waits on the person: each agent waiting on them, on the
//!                               devices this phone paired with, the one waiting longest first
//!   hive-phone watch <workspace> <tile>
//!                               an agent's terminal, read-only: its screen, then its output as
//!                               it comes, until it ends (or Ctrl+C)
//!   hive-phone answer <workspace> <tile> <since> --text <line> | --approve | --changes <what>
//!                               answer what an agent waits on you for (`needs --json` names the
//!                               wait): a line typed into its terminal, or its plan approved or
//!                               sent back; only while it still waits on that, and once
//!
//! Options: `--identity <dir>` (default: `hivemind-phone/identity` in this user's data folder),
//! `--name <name>` (pair: what the app lists this phone as; default `Phone`), `--json` (pair,
//! devices, needs, answer: as JSON).

use std::{path::PathBuf, process::ExitCode, time::SystemTime};

use anyhow::{bail, Context, Result};
use hive_net::net::{self, Reach};
use hive_phone::{
    identity::Identity,
    needs::{self, Need},
    pairing, workspace,
};
use serde_json::{json, Value};

const USAGE: &str = "usage: hive-phone id | pair <link> | devices | needs | watch <workspace> <tile> | answer <workspace> <tile> <since> --text <line>|--approve|--changes <what>  [--identity <dir>] [--name <name>] [--json]";

#[derive(Default)]
struct Args {
    command: String,
    /// What follows the command: `pair`'s link; `watch`'s and `answer`'s workspace, tile, …
    rest: Vec<String>,
    identity: Option<PathBuf>,
    name: Option<String>,
    json: bool,
    /// `answer`'s: a line to type, or a plan's decision and what to change.
    text: Option<String>,
    approve: bool,
    changes: Option<String>,
}

fn parse(mut argv: impl Iterator<Item = String>) -> Result<Args> {
    let mut args = Args::default();
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--identity" => {
                args.identity = Some(argv.next().context("--identity needs a value")?.into())
            }
            "--name" => args.name = Some(argv.next().context("--name needs a value")?),
            "--json" => args.json = true,
            "--text" => args.text = Some(argv.next().context("--text needs a value")?),
            "--approve" => args.approve = true,
            "--changes" => args.changes = Some(argv.next().context("--changes needs a value")?),
            flag if flag.starts_with("--") => bail!("{flag} is not an option\n{USAGE}"),
            _ if args.command.is_empty() => args.command = arg,
            _ => args.rest.push(arg),
        }
    }
    Ok(args)
}

/// Where this phone's keys are kept.
fn identity_dir(args: &Args) -> Result<PathBuf> {
    match &args.identity {
        Some(dir) => Ok(dir.clone()),
        None => Ok(hive_net::key::data_dir()
            .context("no data folder here: name one with --identity <dir>")?
            .join("hivemind-phone")
            .join("identity")),
    }
}

/// What an agent waits on the person for, in words.
fn what(n: &Need) -> &'static str {
    match n.kind.as_str() {
        "permission" => "needs permission",
        "question" => "asks you something",
        "plan" => "has a plan for you to review",
        "approval" => "waits on your approval",
        _ => "needs you",
    }
}

/// How long since `since`, as a person says it.
fn waited(since: u64, now: u64) -> String {
    let s = now.saturating_sub(since) / 1000;
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("waiting {} min", s / 60),
        _ => format!("waiting {} h", s / 3600),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

async fn run(args: Args) -> Result<()> {
    let phone = Identity::open(&identity_dir(&args)?)?;
    match args.command.as_str() {
        "id" => println!("{}", phone.id()),
        "pair" => {
            let text = args
                .rest
                .first()
                .map(String::as_str)
                .context("pair: which link?")?;
            let link = pairing::parse_link(text).context(
                "that is not a pairing link: it is the one under Settings → Devices on your computer",
            )?;
            // On the local network; the link says where the app is.
            let endpoint = net::endpoint(phone.key().clone(), &Reach::local(), vec![]).await?;
            let paired =
                pairing::pair(&endpoint, args.name.as_deref().unwrap_or("Phone"), &link).await;
            endpoint.close().await;
            let paired = paired?;
            phone.keep(&paired, now_ms())?;
            let person = &paired.certificate.person;
            if args.json {
                let w = &paired.with;
                println!(
                    "{}",
                    json!({ "device": w.device, "name": w.name, "kind": w.kind, "person": person })
                );
            } else {
                println!(
                    "paired with {}: this phone is its person's ({}…) from now on",
                    paired.with.name,
                    &person[..8]
                );
            }
        }
        "devices" => {
            let devices = phone.devices();
            if args.json {
                println!("{}", serde_json::to_string(&devices)?);
            } else if devices.is_empty() {
                println!("none: pair this phone with `hive-phone pair <link>`");
            } else {
                for d in devices {
                    println!("{}  {}  {}…", d.with.name, d.with.kind, &d.with.device[..8]);
                }
            }
        }
        "needs" => {
            let devices = phone.devices();
            if devices.is_empty() {
                bail!("this phone is paired with nothing yet: `hive-phone pair <link>`");
            }
            // Each asked at once: one away holds up none of the others.
            let endpoint = net::endpoint(phone.key().clone(), &Reach::local(), vec![]).await?;
            let mut asking = tokio::task::JoinSet::new();
            for d in devices {
                let endpoint = endpoint.clone();
                asking.spawn(async move { (needs::ask(&endpoint, &d.with).await, d.with) });
            }
            let (mut lists, mut away) = (vec![], vec![]);
            while let Some(Ok((answer, device))) = asking.join_next().await {
                match answer {
                    Ok(list) => lists.push(list),
                    Err(_) => away.push(device),
                }
            }
            endpoint.close().await;
            let all = needs::as_one(lists);
            if args.json {
                let away: Vec<_> = away
                    .iter()
                    .map(|d| json!({ "device": d.device, "name": d.name }))
                    .collect();
                println!("{}", json!({ "needs": all, "away": away }));
            } else {
                if all.is_empty() {
                    println!("Nothing needs you.");
                }
                for n in &all {
                    println!(
                        "{} · {} — {} · {}",
                        n.agent,
                        n.name,
                        what(n),
                        waited(n.since, now_ms())
                    );
                }
                for d in &away {
                    println!("{} is away: what waits there is not known.", d.name);
                }
            }
        }
        "watch" => {
            let [ws, tile] = &args.rest[..] else {
                bail!("watch: which workspace and tile? (`hive-phone needs --json` names them)");
            };
            let devices: Vec<_> = phone.devices().into_iter().map(|d| d.with).collect();
            let endpoint = net::endpoint(phone.key().clone(), &Reach::local(), vec![]).await?;
            let watched = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                let mut stdout = std::io::stdout();
                workspace::watch(&connection, ws, tile, |data| {
                    let _ = std::io::Write::write_all(&mut stdout, data.as_bytes());
                    let _ = std::io::Write::flush(&mut stdout);
                })
                .await
            };
            let ended = watched.await;
            endpoint.close().await;
            if let Some(ended) = ended? {
                eprintln!("\nhive-phone: the session ended ({})", ended.code);
            }
        }
        "answer" => {
            let [ws, tile, since] = &args.rest[..] else {
                bail!("answer: which workspace, tile and wait? (`hive-phone needs --json` names them)");
            };
            let since: u64 = since
                .parse()
                .context("answer: the wait is when it began, a number")?;
            let answer: Value = match (&args.text, args.approve, &args.changes) {
                (Some(text), false, None) => json!({ "text": text }),
                (None, true, None) => json!({ "decision": "allow" }),
                (None, false, Some(changes)) => json!({ "decision": "deny", "feedback": changes }),
                _ => bail!("answer: --text <line>, --approve or --changes <what>, one of them"),
            };
            let devices: Vec<_> = phone.devices().into_iter().map(|d| d.with).collect();
            let endpoint = net::endpoint(phone.key().clone(), &Reach::local(), vec![]).await?;
            let answered = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                workspace::answer(&connection, ws, tile, since, answer).await
            };
            let answered = answered.await;
            endpoint.close().await;
            let answered = answered?;
            if args.json {
                println!("{}", json!({ "answered": answered }));
            } else if answered {
                println!("answered");
            } else {
                println!("not answered: it waits on that no more, or it was answered already");
            }
        }
        "" => bail!("{USAGE}"),
        other => bail!("{other}: not a command\n{USAGE}"),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    let result = match parse(std::env::args().skip(1)) {
        Ok(args) => run(args).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("hive-phone: {e:#}");
            ExitCode::FAILURE
        }
    }
}

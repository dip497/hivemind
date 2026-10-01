//! `hive-phone`: in a terminal, what the phone does (M5).
//!
//!   hive-phone id               print this phone's id (its device key's public half)
//!   hive-phone pair <link>      pair with the app that shows this link (Settings → Devices on a
//!                               computer): this phone is that app's person from then on
//!   hive-phone devices          the person's devices this phone paired with
//!   hive-phone needs            what waits on the person: each agent waiting on them, on the
//!                               devices this phone paired with, the one waiting longest first
//!
//! Options: `--identity <dir>` (default: `hivemind-phone/identity` in this user's data folder),
//! `--name <name>` (pair: what the app lists this phone as; default `Phone`), `--json` (pair,
//! devices, needs: as JSON).

use std::{path::PathBuf, process::ExitCode, time::SystemTime};

use anyhow::{bail, Context, Result};
use hive_net::net::{self, Reach};
use hive_phone::{
    identity::Identity,
    needs::{self, Need},
    pairing,
};
use serde_json::json;

const USAGE: &str = "usage: hive-phone id | pair <link> | devices | needs  [--identity <dir>] [--name <name>] [--json]";

#[derive(Default)]
struct Args {
    command: String,
    target: Option<String>,
    identity: Option<PathBuf>,
    name: Option<String>,
    json: bool,
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
            flag if flag.starts_with("--") => bail!("{flag} is not an option\n{USAGE}"),
            _ if args.command.is_empty() => args.command = arg,
            _ if args.target.is_none() => args.target = Some(arg),
            _ => bail!("{arg}: one too many\n{USAGE}"),
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
            let text = args.target.as_deref().context("pair: which link?")?;
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

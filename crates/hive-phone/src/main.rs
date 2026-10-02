//! `hive-phone`: in a terminal, what the phone does (M5).
//!
//!   hive-phone id               print this phone's id (its device key's public half)
//!   hive-phone pair <link>      pair with the app that shows this link (Settings → Devices on a
//!                               computer): this phone is that app's person from then on
//!   hive-phone devices          the person's devices this phone paired with
//!   hive-phone network          the network it reaches them through: the one the app it paired
//!                               with is on, or the local network alone
//!   hive-phone unpair <device>  unpair from one of them (by its id or its name): it forgets
//!                               this phone, and this phone forgets it
//!   hive-phone needs            what waits on the person: each agent waiting on them, on the
//!                               devices this phone paired with, the one waiting longest first,
//!                               and how many are at work; of a device that is away, what it last
//!                               answered and when
//!   hive-phone watch <workspace> <tile> [--type]
//!                               an agent's terminal: its screen, then its output as it comes,
//!                               until it ends (or Ctrl+C); with --type, each line read here is
//!                               typed into it, Enter after it, as you (its keyboard asked for:
//!                               one someone else holds waits until they give it)
//!   hive-phone answer <workspace> <tile> <since> --text <line> | --allow | --deny
//!                     | --approve | --changes <what>
//!                               answer what an agent waits on you for (`needs --json` names the
//!                               wait): a line typed into its terminal; a permission allowed or
//!                               denied with the agent's own keys (one `needs` says it can decide);
//!                               or its plan approved or sent back; only while it still waits on
//!                               that, and once
//!   hive-phone send <workspace> <tile> --text <line>
//!                               send an agent a message, whatever it is doing: it goes in as its
//!                               next prompt
//!   hive-phone push --listen <ip:port>
//!                               be told what happens on the devices this phone paired with (an
//!                               agent begins waiting on you, finishes, fails): they post to this
//!                               address, or, on a network with a push server, to the address it
//!                               gives this phone, which passes each on here (a UnifiedPush
//!                               distributor's part); each notice is printed as it comes, until
//!                               Ctrl+C
//!
//! Options: `--identity <dir>` (default: `hivemind-phone/identity` in this user's data folder),
//! `--name <name>` (pair: what the app lists this phone as; default `Phone`), `--json` (pair,
//! devices, network, unpair, needs, answer, send, push: as JSON, a notice a line).

use std::{path::PathBuf, process::ExitCode, sync::Arc, time::SystemTime};

use anyhow::{bail, Context, Result};
use hive_net::{net, push::Platform};
use hive_phone::{
    identity::Identity,
    needs::{self, Need},
    pairing,
    push::{self, PushKeys},
    workspace::{self, Watched},
};
use serde_json::{json, Value};

const USAGE: &str = "usage: hive-phone id | pair <link> | devices | network | unpair <device> | needs | watch <workspace> <tile> [--type] | answer <workspace> <tile> <since> --text <line>|--allow|--deny|--approve|--changes <what> | send <workspace> <tile> --text <line> | push --listen <ip:port>  [--identity <dir>] [--name <name>] [--json]";

#[derive(Default)]
struct Args {
    command: String,
    /// What follows the command: `pair`'s link; `watch`'s and `answer`'s workspace, tile, …
    rest: Vec<String>,
    identity: Option<PathBuf>,
    name: Option<String>,
    json: bool,
    /// `answer`'s: a line to type; a permission allowed or denied; a plan approved, or what to
    /// change in it; `send`'s message.
    text: Option<String>,
    allow: bool,
    deny: bool,
    approve: bool,
    changes: Option<String>,
    /// `push`'s: where this phone listens for its notices.
    listen: Option<String>,
    /// `watch`'s: each line read here is typed into the terminal.
    typing: bool,
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
            "--allow" => args.allow = true,
            "--deny" => args.deny = true,
            "--approve" => args.approve = true,
            "--changes" => args.changes = Some(argv.next().context("--changes needs a value")?),
            "--listen" => args.listen = Some(argv.next().context("--listen needs a value")?),
            "--type" => args.typing = true,
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
        "permission" if n.decide => "needs permission (allow or deny it here)",
        "permission" => "needs permission",
        "question" => "asks you something",
        "plan" => "has a plan for you to review",
        "approval" => "waits on your approval",
        _ => "needs you",
    }
}

/// What waits, and how many agents are at work, as a person says it.
fn summary(needs: &[Need], working: u64, now: u64) -> Vec<String> {
    let mut lines: Vec<String> = needs
        .iter()
        .map(|n| {
            let waits = format!("{} · {}", what(n), waited(n.since, now));
            match &n.machine {
                Some(machine) => format!("{} · {} on {machine} — {waits}", n.agent, n.name),
                None => format!("{} · {} — {waits}", n.agent, n.name),
            }
        })
        .collect();
    let at_work = match working {
        0 => None,
        1 => Some("1 agent working.".to_string()),
        n => Some(format!("{n} agents working.")),
    };
    match (lines.is_empty(), at_work) {
        (true, Some(w)) => lines.push(format!("Nothing needs you. {w}")),
        (true, None) => lines.push("Nothing needs you.".into()),
        (false, Some(w)) => lines.push(w),
        (false, None) => {}
    }
    lines
}

/// How long ago `at` was, as a person says it.
fn ago(at: u64, now: u64) -> String {
    let s = now.saturating_sub(at) / 1000;
    match s {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", s / 60),
        _ => format!("{} h ago", s / 3600),
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
            // Onto the app's network first, as its link says, to reach it from anywhere; then to
            // the app, where the link says it is.
            let admission = match &link.admission {
                Some(admission) => phone
                    .let_in(admission)
                    .await
                    .context("not let onto the app's network")?,
                None => "none needed",
            };
            let reach = phone.reach_through(link.relay.as_deref());
            let endpoint = net::endpoint(phone.key().clone(), &reach, vec![]).await?;
            let paired =
                pairing::pair(&endpoint, args.name.as_deref().unwrap_or("Phone"), &link).await;
            endpoint.close().await;
            let paired = paired?;
            phone.keep(&paired, now_ms())?;
            let network = phone.network().map(|n| n.profile.name);
            let person = &paired.certificate.person;
            if args.json {
                let w = &paired.with;
                println!(
                    "{}",
                    json!({ "device": w.device, "name": w.name, "kind": w.kind, "person": person, "network": network, "admission": admission })
                );
            } else {
                println!(
                    "paired with {}: this phone is its person's ({}…) from now on",
                    paired.with.name,
                    &person[..8]
                );
                if let Some(network) = network {
                    println!("on the network {network} ({admission})");
                }
            }
        }
        "network" => {
            let network = phone.network();
            if args.json {
                println!("{}", network.map_or(Value::Null, |n| n.describe()));
            } else if let Some(n) = network {
                let relays: Vec<_> = n.profile.relays.iter().map(|r| r.url.as_str()).collect();
                println!("{}: relays {}", n.profile.name, relays.join(", "));
            } else {
                println!("the local network alone");
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
            if phone.devices().is_empty() {
                bail!("this phone is paired with nothing yet: `hive-phone pair <link>`");
            }
            let (endpoint, devices) = reaching(&phone).await?;
            // Each asked at once: one away holds up none of the others.
            let mut asking = tokio::task::JoinSet::new();
            for d in devices {
                let endpoint = endpoint.clone();
                asking.spawn(async move { (needs::ask(&endpoint, &d).await, d) });
            }
            let (mut answers, mut away) = (vec![], vec![]);
            while let Some(Ok((answer, device))) = asking.join_next().await {
                match answer {
                    Ok(answer) => answers.push((device.device, answer)),
                    Err(_) => away.push(device),
                }
            }
            endpoint.close().await;
            let now = now_ms();
            // What each device answered is kept, for when it is away; and which are away.
            phone.hear(&answers, now)?;
            let gone: Vec<String> = away.iter().map(|d| d.device.clone()).collect();
            phone.mark_away(&gone, now)?;
            let heard = phone.heard();
            let all = needs::as_one(answers.into_iter().map(|(_, a)| a).collect());
            if args.json {
                let away: Vec<_> = away
                    .iter()
                    .map(|d| json!({ "device": d.device, "name": d.name, "heard": heard.get(&d.device) }))
                    .collect();
                println!(
                    "{}",
                    json!({ "needs": all.needs, "working": all.working, "away": away })
                );
            } else {
                for line in summary(&all.needs, all.working, now) {
                    println!("{line}");
                }
                for d in &away {
                    let Some(last) = heard.get(&d.device) else {
                        println!("{} is away: what waits there is not known.", d.name);
                        continue;
                    };
                    println!("{} is away. Last heard {}:", d.name, ago(last.at, now));
                    for line in summary(&last.answer.needs, last.answer.working, now) {
                        println!("  {line}");
                    }
                }
            }
        }
        "unpair" => {
            let which = args
                .rest
                .first()
                .context("unpair: which device? `hive-phone devices` lists them")?;
            let all = phone.devices();
            let devices: Vec<_> = all.iter().map(|d| &d.with).collect();
            let named: Vec<_> = devices.iter().filter(|d| d.name == *which).collect();
            let device = match devices.iter().find(|d| d.device == *which) {
                Some(device) => *device,
                None if named.len() == 1 => *named[0],
                None if named.len() > 1 => {
                    bail!("several devices are called {which}: name it by its id")
                }
                None => bail!("{which} is not a device this phone is paired with"),
            };
            // One this phone learned of from an app is unpaired there: the app tells it.
            if let Some(d) = all
                .iter()
                .find(|d| d.with.device == device.device && !d.via.is_empty())
            {
                let through: Vec<_> = all
                    .iter()
                    .filter(|a| d.via.contains(&a.with.device))
                    .map(|a| a.with.name.as_str())
                    .collect();
                bail!(
                    "{} knows this phone through {}: unpair from that",
                    device.name,
                    through.join(", ")
                );
            }
            let endpoint = net::endpoint(phone.key().clone(), &phone.reach(), vec![]).await?;
            let told = phone.unpair(&endpoint, device).await?;
            endpoint.close().await;
            // Its push server is told the devices that may tell this phone now: not that one.
            if let Err(e) =
                push::register_again(&identity_dir(&args)?, phone.key(), &senders(&phone)?).await
            {
                eprintln!(
                    "hive-phone: the push server still lets {} tell this phone: {e:#}",
                    device.name
                );
            }
            if args.json {
                println!(
                    "{}",
                    json!({ "device": device.device, "name": device.name, "told": told })
                );
            } else if told {
                println!(
                    "Unpaired from {}: it forgot this phone, and this phone forgot it.",
                    device.name
                );
            } else {
                println!(
                    "This phone forgot {0}, but {0} is away and still lists this phone: unpair it there too (Settings → Devices).",
                    device.name
                );
            }
        }
        "watch" => {
            let [ws, tile] = &args.rest[..] else {
                bail!("watch: which workspace and tile? (`hive-phone needs --json` names them)");
            };
            let (endpoint, devices) = reaching(&phone).await?;
            // Typing: each line read here goes into the terminal, Enter after it.
            let typed = args.typing.then(|| {
                let (lines, typed) = tokio::sync::mpsc::channel(16);
                tokio::spawn(async move {
                    use tokio::io::AsyncBufReadExt;
                    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin()).lines();
                    while let Ok(Some(line)) = stdin.next_line().await {
                        if lines.send(line).await.is_err() {
                            return;
                        }
                    }
                });
                typed
            });
            let me = format!("peer:{}", phone.id());
            let watched = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                let mut stdout = std::io::stdout();
                workspace::watch(&connection, ws, tile, typed, |watched| match watched {
                    Watched::Output(data) => {
                        let _ = std::io::Write::write_all(&mut stdout, data.as_bytes());
                        let _ = std::io::Write::flush(&mut stdout);
                    }
                    // Someone else holds its keyboard: what is typed here waits until they give it.
                    Watched::Keyboard(Some(holder)) if args.typing && holder["id"] != me.as_str() => {
                        let name = holder["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("someone");
                        eprintln!("hive-phone: {name} has its keyboard: asked for it, and what you type goes in once it is given");
                    }
                    Watched::Keyboard(_) if args.typing => eprintln!("hive-phone: its keyboard is yours"),
                    Watched::Keyboard(_) => {}
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
            let answer: Value = match (&args.text, args.allow || args.approve, args.deny, &args.changes) {
                (Some(text), false, false, None) => json!({ "text": text }),
                (None, true, false, None) => json!({ "decision": "allow" }),
                (None, false, true, None) => json!({ "decision": "deny" }),
                (None, false, false, Some(changes)) => json!({ "decision": "deny", "feedback": changes }),
                _ => bail!("answer: --text <line>, --allow, --deny, --approve or --changes <what>, one of them"),
            };
            let (endpoint, devices) = reaching(&phone).await?;
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
        "send" => {
            let [ws, tile] = &args.rest[..] else {
                bail!("send: which workspace and tile? (`hive-phone needs --json` names them)");
            };
            let text = args.text.as_deref().context("send: --text <line>")?;
            let (endpoint, devices) = reaching(&phone).await?;
            let sent = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                workspace::send(&connection, ws, tile, text).await
            };
            let sent = sent.await;
            endpoint.close().await;
            let sent = sent?;
            if args.json {
                println!("{}", json!({ "sent": sent }));
            } else if sent {
                println!("sent: it goes in as the agent's next prompt");
            } else {
                println!("not sent: no agent runs there");
            }
        }
        "push" => {
            let dir = identity_dir(&args)?;
            let keys = Arc::new(PushKeys::kept_or_made(&dir)?);
            let at = args.listen.as_deref().context("push: --listen <ip:port>")?;
            let listener = tokio::net::TcpListener::bind(at).await?;
            let listening = format!("http://{}/push", listener.local_addr()?);
            if phone.devices().is_empty() {
                bail!("this phone is paired with nothing yet: `hive-phone pair <link>`");
            }
            let (net, devices) = reaching(&phone).await?;
            // Through the network's push server, when it has one that passes notices on to a
            // distributor: this listener is this phone's.
            let server = phone
                .network()
                .and_then(|n| n.profile.push)
                .filter(|p| p.kinds.iter().any(|k| k == "unifiedpush"))
                .map(|p| p.url);
            let via = match &server {
                Some(url) => {
                    let to = (Platform::Unifiedpush, listening.as_str(), false);
                    match push::register(&dir, phone.key(), url, to, &senders(&phone)?).await {
                        Ok(endpoint) => Some((url.clone(), endpoint)),
                        Err(e) => {
                            eprintln!("hive-phone: {e:#}: the devices post here directly");
                            None
                        }
                    }
                }
                None => None,
            };
            let endpoint = via.as_ref().map_or(listening.clone(), |(_, e)| e.clone());
            let subscription = keys.subscription(&endpoint, via.is_some());
            let (mut told, mut away) = (vec![], vec![]);
            for d in &devices {
                let given = async {
                    let at = hive_net::net::addr_of(&d.device, &d.addrs, &d.relay)?;
                    let connection = net.connect(at, hive_net::ws::ALPN).await?;
                    push::subscribe(&connection, &subscription).await?;
                    connection.close(0u32.into(), b"done");
                    Ok::<_, anyhow::Error>(())
                };
                match tokio::time::timeout(std::time::Duration::from_secs(10), given).await {
                    Ok(Ok(())) => told.push(d.name.clone()),
                    _ => away.push(d.name.clone()),
                }
            }
            net.close().await;
            if args.json {
                println!(
                    "{}",
                    json!({ "endpoint": endpoint, "via": via.map(|(url, _)| url), "told": told, "away": away })
                );
            } else {
                if let Some((url, _)) = &via {
                    println!("told through the push server {url}");
                }
                println!("told at {endpoint}: {}", told.join(", "));
                for name in &away {
                    println!("{name} is away: it is not told where to reach this phone");
                }
            }
            notices(listener, keys, Arc::new(phone), args.json).await?;
        }
        "" => bail!("{USAGE}"),
        other => bail!("{other}: not a command\n{USAGE}"),
    }
    Ok(())
}

/// The devices that may tell this phone what happens on them: the person's, as it knows them.
fn senders(phone: &Identity) -> Result<Vec<iroh::PublicKey>> {
    phone
        .devices()
        .iter()
        .map(|d| {
            d.with
                .device
                .parse()
                .with_context(|| format!("{} is no device", d.with.device))
        })
        .collect()
}

/// This phone on the network, and the person's devices it reaches: those it paired with, and the
/// computers and hosts the apps among them tell of as they are asked now (spec/pairing.md 0.7).
async fn reaching(phone: &Identity) -> Result<(iroh::Endpoint, Vec<pairing::PairedWith>)> {
    let endpoint = net::endpoint(phone.key().clone(), &phone.reach(), vec![]).await?;
    phone.learn_from(&endpoint, now_ms()).await?;
    let devices = phone.devices().into_iter().map(|d| d.with).collect();
    Ok((endpoint, devices))
}

/// Take the notices posted to this phone's endpoint, each decrypted and printed as it comes, until
/// stopped: a device back only when this phone had found it away. One not for this phone, or
/// changed on its way, is refused (400).
async fn notices(
    listener: tokio::net::TcpListener,
    keys: Arc<PushKeys>,
    phone: Arc<Identity>,
    json: bool,
) -> Result<()> {
    use http_body_util::{BodyExt, Empty};
    use hyper::{body::Bytes, server::conn::http1, service::service_fn, Response, StatusCode};
    loop {
        let (stream, _) = listener.accept().await?;
        let (keys, phone) = (keys.clone(), phone.clone());
        tokio::spawn(async move {
            let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let (keys, phone) = (keys.clone(), phone.clone());
                async move {
                    let body = req.into_body().collect().await?.to_bytes();
                    let status = match keys
                        .decrypt(&body)
                        .ok()
                        .and_then(|n| serde_json::from_slice::<Value>(&n).ok())
                    {
                        Some(notice) => {
                            let s = |k: &str| notice[k].as_str().unwrap_or("").to_string();
                            // A device back is shown when this phone had found it away.
                            let shown = notice["t"] != "back"
                                || phone
                                    .back(&s("device"), notice["since"].as_u64().unwrap_or(0))
                                    .unwrap_or_else(|e| {
                                        eprintln!("hive-phone: {e:#}");
                                        false
                                    });
                            if shown && json {
                                println!("{notice}");
                            } else if shown && notice["t"] == "back" {
                                println!("{} is back", s("name"));
                            } else if shown {
                                // A permission its device can allow or deny is answered from here.
                                let decide =
                                    notice["decide"] == true && notice["kind"] == "permission";
                                let here = if decide {
                                    ": allow or deny it here"
                                } else {
                                    ""
                                };
                                println!("{} · {} — {}{here}", s("agent"), s("name"), s("t"));
                            }
                            StatusCode::CREATED
                        }
                        None => StatusCode::BAD_REQUEST,
                    };
                    let mut res = Response::new(Empty::<Bytes>::new());
                    *res.status_mut() = status;
                    Ok::<_, hyper::Error>(res)
                }
            });
            let _ = http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
        });
    }
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

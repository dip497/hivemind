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
//!   hive-phone agents [--follow]
//!                               every agent on the devices this phone reaches, by device: what
//!                               each is doing and what it waits on, and how many are at work;
//!                               with --follow, again each time a device says it changed, until
//!                               Ctrl+C
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
//!   hive-phone start <workspace> [<agent> [--frame <id>] [--prompt <text>] [--model <m>]
//!                     [--mode <m>]]
//!                               start an agent there, as you launch one at your computer (your
//!                               saved options for it, these on top): its tile; with no agent,
//!                               what may be started there and in which frames
//!   hive-phone stop <workspace> <tile>
//!                               interrupt an agent's turn, with the keys its agent says do
//!   hive-phone close <workspace> <tile>
//!                               end an agent's session and take it off its board
//!   hive-phone diff <workspace> <tile>
//!                               what an agent changed in the folder it runs in, against its
//!                               last commit: the files, then the patch
//!   hive-phone talk <workspace> <tile> [--follow]
//!                               what an agent and you said to each other, as its session file
//!                               keeps it: the last of it, then, with --follow, what is said
//!                               next as it comes, until Ctrl+C
//!   hive-phone views <workspace> [<view> <path>]
//!                               the community views the device that holds the workspace offers
//!                               a phone, and the page to load to show each; with a view and a
//!                               path, that file of the view as the device serves it, its bytes
//!                               (with --json, `{type, data, csp}`: data base64, and the policy to
//!                               serve it under)
//!   hive-phone view <workspace> <view> [--size <w>x<h>]
//!                               open a view on the workspace, as the phone shows one, its host on
//!                               that device, on a screen that size (in CSS pixels; none: 0 by 0)
//!                               with no colours of its own: each message its host says, a JSON
//!                               line; each JSON line read here, posted to it; at the end of what
//!                               is read, it is closed (with --json, `{"closed":true}` last), and
//!                               when its host ends it, it says why
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
//! devices, network, unpair, needs, agents, answer, send, start, stop, close, diff, talk, push,
//! views, view: as JSON, a notice, a list or a piece of a conversation a line).

use std::{path::PathBuf, process::ExitCode, sync::Arc};

use anyhow::{bail, Context, Result};
use hive_net::net;
use hive_phone::{
    agents::{self, Agent, Listed},
    control::{self, Start},
    conversation::{self, Entry, Piece},
    devices::{self, Unpaired},
    identity::Identity,
    needs::{self, Need},
    now_ms,
    pairing::{self, Pairing},
    push::{self, PushKeys},
    views,
    workspace::{self, Reply, Watched},
};
use serde_json::{json, Value};

const USAGE: &str = "usage: hive-phone id | pair <link> | devices | network | unpair <device> | needs | agents [--follow] | watch <workspace> <tile> [--type] | answer <workspace> <tile> <since> --text <line>|--allow|--deny|--approve|--changes <what> | send <workspace> <tile> --text <line> | start <workspace> [<agent> [--frame <id>] [--prompt <text>] [--model <m>] [--mode <m>]] | stop <workspace> <tile> | close <workspace> <tile> | diff <workspace> <tile> | talk <workspace> <tile> [--follow] | views <workspace> [<view> <path>] | view <workspace> <view> [--size <w>x<h>] | push --listen <ip:port>  [--identity <dir>] [--name <name>] [--json]";

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
    /// `agents`': again each time a device says they changed.
    follow: bool,
    /// `start`'s: the frame to start it in, its first prompt, its model and its mode.
    frame: Option<String>,
    prompt: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    /// `view`'s: the size of the screen it is shown on, `<w>x<h>`.
    size: Option<String>,
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
            "--follow" => args.follow = true,
            "--frame" => args.frame = Some(argv.next().context("--frame needs a value")?),
            "--prompt" => args.prompt = Some(argv.next().context("--prompt needs a value")?),
            "--model" => args.model = Some(argv.next().context("--model needs a value")?),
            "--mode" => args.mode = Some(argv.next().context("--mode needs a value")?),
            "--size" => args.size = Some(argv.next().context("--size needs a value")?),
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

/// A screen of `size`, `<w>x<h>` in CSS pixels, with no colours of its own.
fn screen_of(size: &str) -> Result<views::Screen> {
    let read = || {
        let (w, h) = size.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    };
    let (w, h) =
        read().with_context(|| format!("--size {size}: give it as <w>x<h>, as 390x844"))?;
    Ok(views::Screen {
        w,
        h,
        ..Default::default()
    })
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

/// Every agent the devices said, and what waits on the person among them: as JSON, one line; else
/// by device, with what each is doing.
fn show_agents(last: &[Option<Listed>], devices: &[pairing::PairedWith], json: bool) {
    let all = agents::as_one(last.iter().flatten().cloned().collect());
    if json {
        println!(
            "{}",
            json!({ "agents": all.agents, "needs": all.needs, "working": all.working })
        );
        return;
    }
    let mut device = None;
    for a in &all.agents {
        if device != Some(&a.device) {
            let name = devices.iter().find(|d| d.device == a.device);
            println!("{}:", name.map_or(a.device.as_str(), |d| d.name.as_str()));
            device = Some(&a.device);
        }
        println!("  {} · {} on {} — {}", a.agent, a.name, a.machine, doing(a));
    }
    match all.working {
        0 if all.agents.is_empty() => println!("No agents."),
        0 => {}
        1 => println!("1 agent working."),
        n => println!("{n} agents working."),
    }
}

/// One thing said, as a line.
fn spoken(e: &Entry) -> String {
    match (&e.text, &e.tool, &e.result) {
        (Some(text), _, _) => format!("{}: {}", e.who, text),
        (_, Some(tool), _) => match &tool.about {
            Some(about) => format!("agent used {}: {about}", tool.name),
            None => format!("agent used {}", tool.name),
        },
        (_, _, Some(r)) => {
            let first = r.text.lines().next().unwrap_or("");
            format!("tool{}: {first}", if r.error { " failed" } else { "" })
        }
        _ => String::new(),
    }
}

/// What an agent is doing, in words.
fn doing(a: &Agent) -> String {
    match &a.waiting {
        Some(w) if w.kind == "approval" => "waits on the agent supervising it".into(),
        Some(w) => what(&Need {
            workspace: a.workspace.clone(),
            name: a.name.clone(),
            tile: a.tile.clone(),
            agent: a.agent.clone(),
            kind: w.kind.clone(),
            since: w.since,
            plan: w.plan.clone(),
            machine: Some(a.machine.clone()),
            decide: w.decide,
        })
        .into(),
        None => a.state.clone(),
    }
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
            let Pairing { paired, admission } = phone
                .pair_with(args.name.as_deref().unwrap_or("Phone"), &link)
                .await?;
            let network = phone.network().map(|n| n.profile.name);
            let person = &paired.certificate.person;
            let whose = phone.person();
            if args.json {
                let w = &paired.with;
                println!(
                    "{}",
                    json!({ "device": w.device, "name": w.name, "kind": w.kind, "person": person, "profile": whose, "network": network, "admission": admission })
                );
            } else {
                let whose = whose.map_or_else(
                    || format!("its person's ({}…)", &person[..8]),
                    |p| format!("{}'s", p.name),
                );
                println!(
                    "paired with {}: this phone is {whose} from now on",
                    paired.with.name
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
                if let Some(p) = phone.person() {
                    let color = if p.color.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", p.color)
                    };
                    println!("{}'s{color}:", p.name);
                }
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
                    let last = heard.get(&d.device);
                    let Some((answer, at)) =
                        last.and_then(|l| Some((l.answer.as_ref()?, l.answered?)))
                    else {
                        println!("{} is away: what waits there is not known.", d.name);
                        continue;
                    };
                    println!("{} is away. Last heard {}:", d.name, ago(at, now));
                    for line in summary(&answer.needs, answer.working, now) {
                        println!("  {line}");
                    }
                }
            }
        }
        "agents" => {
            if phone.devices().is_empty() {
                bail!("this phone is paired with nothing yet: `hive-phone pair <link>`");
            }
            let (endpoint, devices) = reaching(&phone).await?;
            // Each device followed at once: one away holds up none of the others.
            let (told, mut lists) = tokio::sync::mpsc::unbounded_channel::<(usize, Listed)>();
            for (i, d) in devices.iter().cloned().enumerate() {
                let (endpoint, told) = (endpoint.clone(), told.clone());
                tokio::spawn(async move {
                    let followed = async {
                        let at = net::addr_of(&d.device, &d.addrs, &d.relay)?;
                        let connection = endpoint.connect(at, hive_net::ws::ALPN).await?;
                        agents::follow(&connection, &d.device, |list| {
                            let _ = told.send((i, list));
                        })
                        .await
                    };
                    if let Err(e) = followed.await {
                        eprintln!("hive-phone: {} did not answer: {e:#}", d.name);
                    }
                });
            }
            drop(told);
            // Each device's list as it last said it, shown one device after another.
            let mut last: Vec<Option<Listed>> = vec![None; devices.len()];
            let mut heard = 0;
            loop {
                let next = if args.follow || heard == devices.len() {
                    lists.recv().await
                } else {
                    tokio::time::timeout(devices::ANSWER_WITHIN, lists.recv())
                        .await
                        .unwrap_or(None)
                };
                let Some((i, list)) = next else {
                    if !args.follow {
                        show_agents(&last, &devices, args.json);
                    }
                    break;
                };
                heard += usize::from(last[i].is_none());
                last[i] = Some(list);
                if args.follow {
                    show_agents(&last, &devices, args.json);
                } else if heard == devices.len() {
                    show_agents(&last, &devices, args.json);
                    break;
                }
            }
            endpoint.close().await;
        }
        "start" | "stop" | "close" | "diff" => {
            let (ws, rest) = args.rest.split_first().with_context(|| {
                format!(
                    "{}: which workspace? (`hive-phone agents --json` names them)",
                    args.command
                )
            })?;
            let (endpoint, devices) = reaching(&phone).await?;
            let done = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                match (args.command.as_str(), rest) {
                    ("start", []) => {
                        let can = control::startable(&connection, ws).await?;
                        if args.json {
                            println!("{}", serde_json::to_value(&can)?);
                        } else {
                            for p in &can.programs {
                                let choices: Vec<String> = p
                                    .options
                                    .iter()
                                    .map(|o| {
                                        format!(
                                            "--{} {}",
                                            o.id,
                                            if o.values.is_empty() {
                                                "<any>".into()
                                            } else {
                                                o.values.join("|")
                                            }
                                        )
                                    })
                                    .collect();
                                println!("{}  {}  {}", p.id, p.label, choices.join("  "));
                            }
                            for f in &can.frames {
                                println!("--frame {}  {} on {}", f.id, f.name, f.machine);
                            }
                        }
                    }
                    ("start", [program]) => {
                        let start = Start {
                            program: program.clone(),
                            frame: args.frame.clone(),
                            prompt: args.prompt.clone(),
                            model: args.model.clone(),
                            mode: args.mode.clone(),
                        };
                        let tile = control::start(&connection, ws, &start).await?;
                        if args.json {
                            println!("{}", json!({ "tile": tile }));
                        } else {
                            println!("started {tile}");
                        }
                    }
                    ("stop", [tile]) => {
                        let done = control::interrupt(&connection, ws, tile).await?;
                        if args.json {
                            println!("{}", json!({ "interrupted": done }));
                        } else if done {
                            println!("interrupted");
                        } else {
                            bail!("it was not at work: nothing to interrupt");
                        }
                    }
                    ("close", [tile]) => {
                        let done = control::close(&connection, ws, tile).await?;
                        if args.json {
                            println!("{}", json!({ "closed": done }));
                        } else if done {
                            println!("closed");
                        } else {
                            bail!("no agent there to close");
                        }
                    }
                    ("diff", [tile]) => {
                        let changes = control::diff(&connection, ws, tile).await?;
                        if args.json {
                            println!("{}", serde_json::to_value(&changes)?);
                        } else {
                            for f in &changes.files {
                                println!("{} {}  +{} -{}", f.status, f.path, f.added, f.removed);
                            }
                            print!("{}", changes.patch);
                            if changes.truncated {
                                println!("… (cut at 512 KiB)");
                            }
                        }
                    }
                    (command, _) => bail!("{command}: which tile?\n{USAGE}"),
                }
                Ok::<_, anyhow::Error>(())
            };
            let done = done.await;
            endpoint.close().await;
            done?;
        }
        "talk" => {
            let [ws, tile] = &args.rest[..] else {
                bail!("talk: which workspace and tile? (`hive-phone agents --json` names them)");
            };
            let (endpoint, devices) = reaching(&phone).await?;
            let talked = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                let (pieces, mut heard) = tokio::sync::mpsc::unbounded_channel();
                let following = {
                    let (ws, tile) = (ws.clone(), tile.clone());
                    tokio::spawn(async move {
                        conversation::follow(&connection, &ws, &tile, None, |piece| {
                            let _ = pieces.send(piece);
                        })
                        .await
                    })
                };
                // The last of it, then, following, each piece as it comes; a session begun since
                // under a line of its own.
                let mut session = None;
                while let Some(piece) = heard.recv().await {
                    let anew = session
                        .replace(piece.session.clone())
                        .is_some_and(|s| s != piece.session);
                    if args.json {
                        let Piece {
                            entries,
                            cursor,
                            session,
                        } = piece;
                        println!(
                            "{}",
                            json!({ "entries": entries, "cursor": cursor, "session": session })
                        );
                    } else {
                        if anew {
                            println!("— a new conversation —");
                        }
                        for e in &piece.entries {
                            println!("{}", spoken(e));
                        }
                    }
                    if !args.follow {
                        break;
                    }
                }
                following.abort();
                Ok::<_, anyhow::Error>(())
            };
            let talked = talked.await;
            endpoint.close().await;
            talked?;
        }
        "views" => {
            let Some((ws, rest)) = args.rest.split_first() else {
                bail!("views: which workspace? (`hive-phone agents --json` names them)");
            };
            let (endpoint, devices) = reaching(&phone).await?;
            let done = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                match rest {
                    [] => {
                        let offered = views::list(&connection, ws).await?;
                        if args.json {
                            println!("{}", serde_json::to_value(&offered)?);
                        } else if offered.is_empty() {
                            println!("no view there says it works on a phone");
                        }
                        for v in offered.iter().filter(|_| !args.json) {
                            println!("{}  {}  {}  {}", v.id, v.name, v.version, v.page);
                        }
                    }
                    [view, path] => {
                        let file = views::file(&connection, ws, view, path).await?;
                        if args.json {
                            use base64::Engine;
                            let data =
                                base64::engine::general_purpose::STANDARD.encode(&file.bytes);
                            println!(
                                "{}",
                                json!({ "type": file.mime, "data": data, "csp": file.csp })
                            );
                        } else {
                            std::io::Write::write_all(&mut std::io::stdout(), &file.bytes)?;
                        }
                    }
                    _ => bail!("views: a view and one of its files, or neither\n{USAGE}"),
                }
                Ok::<_, anyhow::Error>(())
            };
            let done = done.await;
            endpoint.close().await;
            done?;
        }
        "view" => {
            let [ws, view] = &args.rest[..] else {
                bail!(
                    "view: which workspace and view? (`hive-phone views <workspace>` names them)"
                );
            };
            let screen = match &args.size {
                Some(size) => screen_of(size)?,
                None => views::Screen::default(),
            };
            let (endpoint, devices) = reaching(&phone).await?;
            // Each line read here, as JSON, is posted to the view; the end of them closes it.
            let (lines, posts) = tokio::sync::mpsc::channel(16);
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut stdin = tokio::io::BufReader::new(tokio::io::stdin()).lines();
                while let Ok(Some(line)) = stdin.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let message = match serde_json::from_str::<Value>(&line) {
                        Ok(message) => message,
                        Err(e) => {
                            eprintln!("hive-phone: not posted, not JSON: {e}");
                            continue;
                        }
                    };
                    if lines.send(message).await.is_err() {
                        return;
                    }
                }
            });
            let shown = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                let session = views::Session::open(&connection, ws, view, &screen).await?;
                // Its screen stays as it is.
                let (_sized, mut screen) = tokio::sync::watch::channel(screen);
                let mut posts = posts;
                let said = |message| println!("{message}");
                session.relay(&mut posts, &mut screen, false, said).await
            };
            let ended = shown.await;
            endpoint.close().await;
            match ended? {
                views::Ended::Closed if args.json => println!("{}", json!({ "closed": true })),
                views::Ended::Closed => eprintln!("hive-phone: closed"),
                views::Ended::Host(why) => bail!("its host ended the view: {why}"),
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
            let endpoint = net::endpoint(phone.key().clone(), &phone.reach(), vec![]).await?;
            let unpaired = phone.unpair_from(&endpoint, &device.device).await;
            endpoint.close().await;
            let Unpaired { told, still_told } = unpaired?;
            if let Some(e) = still_told {
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
                        if lines.send(format!("{line}\r")).await.is_err() {
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
                    // Someone else holds its keyboard: what is typed here asks for it, and waits until
                    // they give it.
                    Watched::Keyboard(Some(holder)) if args.typing && holder["id"] != me.as_str() => {
                        let name = holder["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("someone");
                        eprintln!("hive-phone: {name} has its keyboard: what you type asks for it, and goes in once it is given");
                    }
                    Watched::Keyboard(_) if args.typing => eprintln!("hive-phone: its keyboard is yours"),
                    Watched::Keyboard(_) | Watched::Size(..) => {}
                })
                .await
            };
            let ended = watched.await;
            endpoint.close().await;
            match ended?.map(|ended| ended.code) {
                Some(Some(code)) => eprintln!("\nhive-phone: the session ended ({code})"),
                Some(None) => eprintln!("hive-phone: no session runs there"),
                None => {}
            }
        }
        "answer" => {
            let [ws, tile, since] = &args.rest[..] else {
                bail!("answer: which workspace, tile and wait? (`hive-phone needs --json` names them)");
            };
            let since: u64 = since
                .parse()
                .context("answer: the wait is when it began, a number")?;
            let reply = match (&args.text, args.allow, args.deny, args.approve, &args.changes) {
                (Some(text), false, false, false, None) => Reply::Text(text.clone()),
                (None, true, false, false, None) => Reply::Decide { allow: true },
                (None, false, true, false, None) => Reply::Decide { allow: false },
                (None, false, false, true, None) => Reply::Plan { approve: true, feedback: None },
                (None, false, false, false, Some(changes)) => Reply::Plan { approve: false, feedback: Some(changes.clone()) },
                _ => bail!("answer: --text <line>, --allow, --deny, --approve or --changes <what>, one of them"),
            };
            let (endpoint, devices) = reaching(&phone).await?;
            let answered = async {
                let connection = workspace::holder(&endpoint, &devices, ws).await?;
                workspace::answer(&connection, ws, tile, since, &reply).await
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
            let push::Subscribing {
                subscription,
                via,
                unregistered,
            } = push::subscribing(&phone, push::PushAt::Endpoint(&listening)).await?;
            if let Some(why) = unregistered {
                eprintln!("hive-phone: {why}: the devices post here directly");
            }
            let endpoint = subscription["endpoint"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let (mut told, mut away, mut refused) = (vec![], vec![], vec![]);
            for d in &devices {
                let reaching = async {
                    let at = hive_net::net::addr_of(&d.device, &d.addrs, &d.relay)?;
                    Ok(net.connect(at, hive_net::ws::ALPN).await?)
                };
                match push::tell(reaching, &subscription).await {
                    push::Took::Yes => told.push(d.name.clone()),
                    push::Took::Refused(why) => refused.push((d.name.clone(), why)),
                    push::Took::Away => away.push(d.name.clone()),
                }
            }
            net.close().await;
            if args.json {
                let refused: Vec<Value> = refused
                    .iter()
                    .map(|(device, why)| json!({ "device": device, "why": why }))
                    .collect();
                let told = json!({ "endpoint": endpoint, "via": via, "told": told, "away": away,
                    "refused": refused });
                println!("{told}");
            } else {
                if let Some(url) = &via {
                    println!("told through the push server {url}");
                }
                println!("told at {endpoint}: {}", told.join(", "));
                for name in &away {
                    println!("{name} is away: it is not told where to reach this phone");
                }
                for (name, why) in &refused {
                    println!("{name} said no: {why}");
                }
            }
            notices(listener, keys, Arc::new(phone), args.json).await?;
        }
        "" => bail!("{USAGE}"),
        other => bail!("{other}: not a command\n{USAGE}"),
    }
    Ok(())
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
                    let status = match keys.read(&body).ok() {
                        Some(notice) => {
                            let s = |k: &str| notice[k].as_str().unwrap_or("").to_string();
                            let shown = push::shown(&phone, &notice).unwrap_or_else(|e| {
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

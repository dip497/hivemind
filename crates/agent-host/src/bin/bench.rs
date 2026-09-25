//! The daemon's hot path in Rust: N PTYs streaming agent-like output into a screen model, the
//! screen read every 1.2s as the host's screen watcher does. Prints this process's CPU and RSS.
//! Usage: bench <sessions> <seconds> <stream-script>
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn cpu_secs() -> f64 {
    // utime + stime of this process, in clock ticks (100/s on Linux).
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let f: Vec<&str> = stat.rsplit(')').next().unwrap().split_whitespace().collect();
    (f[11].parse::<f64>().unwrap() + f[12].parse::<f64>().unwrap()) / 100.0
}

fn rss_mb() -> f64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let kb: f64 = status.lines().find(|l| l.starts_with("VmRSS:")).unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
    kb / 1024.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: usize = args[1].parse().unwrap();
    let secs: u64 = args[2].parse().unwrap();
    // Absolute: a PTY child starts in the home directory, not ours.
    let script = std::fs::canonicalize(&args[3]).unwrap().to_string_lossy().into_owned();
    let pty = native_pty_system();
    let mut screens = vec![];
    let mut children = vec![];
    for _ in 0..n {
        let pair = pty.openpty(PtySize { rows: 24, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new("bash");
        cmd.arg(&script);
        children.push(pair.slave.spawn_command(cmd).unwrap());
        let parser = Arc::new(Mutex::new(vt100::Parser::new(24, 100, 5000)));
        let mut reader = pair.master.try_clone_reader().unwrap();
        let p = parser.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            while let Ok(k) = reader.read(&mut buf) {
                if k == 0 { break; }
                p.lock().unwrap().process(&buf[..k]);
            }
        });
        screens.push((parser, pair.master));
    }
    // Let every session come up, then measure a steady window.
    std::thread::sleep(Duration::from_secs(3));
    let (c0, t0) = (cpu_secs(), Instant::now());
    let mut bytes_read = 0usize;
    while t0.elapsed() < Duration::from_secs(secs) {
        std::thread::sleep(Duration::from_millis(1200));
        for (p, _) in &screens { bytes_read += p.lock().unwrap().screen().contents().len(); }
    }
    let wall = t0.elapsed().as_secs_f64();
    println!("{{\"host\":\"rust\",\"sessions\":{},\"cpuPct\":{:.1},\"rssMb\":{:.0},\"screenChars\":{}}}", n, (cpu_secs() - c0) / wall * 100.0, rss_mb(), bytes_read);
    for mut c in children { let _ = c.kill(); }
}

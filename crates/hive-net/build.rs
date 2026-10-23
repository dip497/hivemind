//! The phone page this hive-net carries: the folder `HIVE_NET_PHONE_PAGE` names (the release's
//! `phone/`, as `hive-phone-page.tar.gz` holds it) is built into the binary, so a server serves the
//! page of its own release and an upgrade of the one is an upgrade of the other. Without it the
//! binary carries none, and `serve --phone-folder <dir>` serves a page built here.

use std::{env, fmt::Write, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-env-changed=HIVE_NET_PHONE_PAGE");
    let mut files = Vec::new();
    if let Some(dir) = env::var_os("HIVE_NET_PHONE_PAGE") {
        let dir = Path::new(&dir)
            .canonicalize()
            .expect("HIVE_NET_PHONE_PAGE names a folder");
        assert!(
            dir.join("index.html").is_file() && dir.join("page.sha256").is_file(),
            "{} is not the phone page: no index.html or page.sha256",
            dir.display()
        );
        println!("cargo:rerun-if-changed={}", dir.display());
        walk(&dir, &dir, &mut files);
        files.sort();
    }
    let mut out = String::from(
        "/// Each file of the phone page this binary carries, by its name in the page.\n",
    );
    out.push_str("pub static CARRIED: &[(&str, &[u8])] = &[\n");
    for (name, path) in &files {
        writeln!(out, "    ({name:?}, include_bytes!({path:?})),").unwrap();
    }
    out.push_str("];\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("carried_page.rs"),
        out,
    )
    .unwrap();
}

/// Every file under `dir`, named by its path from `root` with `/` between folders.
fn walk(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
        {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, files);
        } else {
            let name = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            files.push((name, path.to_string_lossy().into_owned()));
        }
    }
}

#![cfg(unix)]
use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

pub(crate) fn run_fixture(
    command: &mut Command,
    directories: &mut [&mut tempfile::TempDir],
) -> std::process::Output {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let reap_deadline = Instant::now() + Duration::from_secs(2);
            while child.try_wait().unwrap().is_none() && Instant::now() < reap_deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            // Preserve only this fixture when the OS cannot settle its execution;
            // don't remove files from under an unconfirmed child or hang Cargo.
            for directory in directories {
                directory.disable_cleanup(true);
                eprintln!(
                    "preserved fixture {} for child {}",
                    directory.path().display(),
                    child.id()
                );
            }
            panic!(
                "fixture execution exceeded bounded wait; pid {}",
                child.id()
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

fn compile_native(target: &str) -> String {
    format!(
        "/usr/bin/clang -x c - -o \"{target}\" <<'FIXTURE_C'\n#include <stdio.h>\nint main(int argc, char **argv) {{ for (int i=1; i<argc; ++i) {{ if (i>1) putchar(' '); fputs(argv[i], stdout); }} putchar('\\n'); return 0; }}\nFIXTURE_C"
    )
}

struct Fixture {
    directory: tempfile::TempDir,
    runtime: NodeRuntime,
    lease: crate::install_job::Lease,
}

impl Fixture {
    fn new(postinstall: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let node = directory.path().join("node");
        let npm = directory.path().join("npm");
        // This selected interpreter only handles the test's text entry. A native
        // payload sent to it instead of exec'd must fail, not accidentally pass.
        std::fs::write(&node, "#!/bin/sh\ncase \"$(/usr/bin/head -c 2 \"$1\")\" in '#!') exec /bin/sh \"$@\";; *) exit 77;; esac\n").unwrap();
        std::fs::write(&npm, format!("#!/bin/sh\nset -eu\n{postinstall}\n")).unwrap();
        for path in [&node, &npm] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let id = format!("npm-entry-{}", directory.path().display());
        let lease = crate::install_job::begin(&id, tauri::ipc::Channel::new(|_| Ok(()))).unwrap();
        Self {
            directory,
            runtime: NodeRuntime {
                node,
                npm: NpmRunner::System { npm },
                source: "fixture",
                version: None,
            },
            lease,
        }
    }

    fn root(&self) -> PathBuf {
        self.directory.path().join("candidate")
    }

    fn install(&self) -> Result<NpmLaunch, String> {
        npm_install(
            &self.runtime,
            "fixture@0.230.0",
            &self.root(),
            &self.lease.job,
        )
    }
}

fn manifest(bin: &str) -> String {
    format!(
        "mkdir -p \"$3/node_modules/fixture/bin\"\nprintf '%s' '{{\"name\":\"fixture\",\"version\":\"0.230.0\",\"bin\":{{\"fixture\":\"{bin}\"}}}}' > \"$3/node_modules/fixture/package.json\""
    )
}

#[test]
fn fixed_postinstall_hardlink_runs_native_with_registry_arguments_once() {
    let mut fixture = Fixture::new(&format!(
        "{}\nmkdir -p \"$3/node_modules/@fixture/platform\"\n{}\n/bin/ln \"$3/node_modules/@fixture/platform/program\" \"$3/node_modules/fixture/bin/entry\"",
        manifest("bin/entry"),
        compile_native("$3/node_modules/@fixture/platform/program")
    ));
    let launch = fixture.install().unwrap();
    let output = run_fixture(
        Command::new(&launch.command)
            .args(&launch.prefix_args)
            .args(["exec", "--output-format", "acp-daemon", "one argument"]),
        &mut [&mut fixture.directory],
    );
    assert!(output.status.success(), "native entry was sent to Node");
    assert_eq!(
        output.stdout,
        b"exec --output-format acp-daemon one argument\n"
    );
    assert!(launch.prefix_args.is_empty());
}

#[test]
fn fixed_postinstall_platform_symlink_runs_the_same_installation_native() {
    let mut fixture = Fixture::new(&format!(
        "{}\nmkdir -p \"$3/node_modules/@fixture/platform\"\n{}\n/bin/ln -s ../../@fixture/platform/program \"$3/node_modules/fixture/bin/entry.js\"",
        manifest("bin/entry.js"),
        compile_native("$3/node_modules/@fixture/platform/program")
    ));
    let launch = fixture.install().unwrap();
    let output = run_fixture(
        Command::new(&launch.command)
            .args(&launch.prefix_args)
            .arg("native-with-js-extension"),
        &mut [&mut fixture.directory],
    );
    assert!(output.status.success());
    assert_eq!(output.stdout, b"native-with-js-extension\n");
    assert_eq!(
        launch.command,
        fixture
            .root()
            .join("node_modules/@fixture/platform/program")
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn text_entry_without_extension_keeps_selected_node_and_arguments() {
    let mut fixture = Fixture::new(&format!(
        "{}\nprintf '%s\\n' '#!/usr/bin/env node' 'printf \"selected-node:%s\\n\" \"$@\"' > \"$3/node_modules/fixture/bin/entry\"",
        manifest("bin/entry")
    ));
    let launch = fixture.install().unwrap();
    assert_eq!(launch.command, fixture.runtime.node);
    assert_eq!(launch.prefix_args.len(), 1);
    let output = run_fixture(
        Command::new(&launch.command)
            .args(&launch.prefix_args)
            .args(["--acp", "two words"]),
        &mut [&mut fixture.directory],
    );
    assert!(output.status.success());
    assert_eq!(
        output.stdout,
        b"selected-node:--acp\nselected-node:two words\n"
    );
}

#[test]
fn bin_symlink_cannot_escape_this_installation() {
    let fixture = Fixture::new(&format!(
        "{}\n/bin/ln -s /bin/echo \"$3/node_modules/fixture/bin/entry\"",
        manifest("bin/entry")
    ));
    assert!(fixture.install().is_err());
}

#[test]
fn named_companion_keeps_its_existing_package_boundary() {
    let fixture = Fixture::new(&format!(
        "{}\nmkdir -p \"$3/node_modules/@fixture/platform\"\n/bin/cp /bin/echo \"$3/node_modules/@fixture/platform/program\"\n/bin/ln -s ../../@fixture/platform/program \"$3/node_modules/fixture/bin/entry\"",
        manifest("bin/entry")
    ));
    assert!(
        npm_install_named(
            &fixture.runtime,
            "fixture@0.230.0",
            "fixture",
            &fixture.root(),
            &fixture.lease.job
        )
        .is_err()
    );
}

#[test]
fn directory_and_nonexecutable_native_are_not_launchable_entries() {
    for postinstall in [
        "mkdir \"$3/node_modules/fixture/bin/entry\"",
        "/bin/cp /bin/echo \"$3/node_modules/fixture/bin/entry\"\n/bin/chmod 644 \"$3/node_modules/fixture/bin/entry\"",
    ] {
        let fixture = Fixture::new(&format!("{}\n{postinstall}", manifest("bin/entry")));
        assert!(fixture.install().is_err());
    }
}

#[test]
fn dangling_entry_link_is_rejected_without_following_another_target() {
    let fixture = Fixture::new(&manifest("bin/entry"));
    let package = fixture.root().join("node_modules/fixture/bin");
    std::fs::create_dir_all(&package).unwrap();
    symlink("missing", package.join("entry")).unwrap();
    assert!(fixture.install().is_err());
}

#[test]
fn malformed_mach_headers_do_not_fall_back_to_node() {
    let fixture = Fixture::new(&manifest("bin/entry"));
    let entry = fixture.root().join("node_modules/fixture/bin/entry");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    let mut thin = vec![0; 32];
    thin[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
    thin[4..8].copy_from_slice(&0x0100_000c_u32.to_le_bytes());
    thin[12..16].copy_from_slice(&2_u32.to_le_bytes());
    std::fs::write(&entry, &thin).unwrap();
    std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755)).unwrap();
    let launch = fixture.install().unwrap();
    assert_eq!(launch.command, entry.canonicalize().unwrap());
    assert!(launch.prefix_args.is_empty());

    let mut library = thin.clone();
    library[12..16].copy_from_slice(&6_u32.to_le_bytes());
    let mut truncated_commands = thin.clone();
    truncated_commands[20..24].copy_from_slice(&8_u32.to_le_bytes());
    let mut huge_arch_count = vec![0xca, 0xfe, 0xba, 0xbe];
    huge_arch_count.extend_from_slice(&u32::MAX.to_be_bytes());
    let mut outside_slice = vec![0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 1];
    outside_slice.extend_from_slice(&[0; 20]);
    outside_slice[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
    outside_slice[20..24].copy_from_slice(&32_u32.to_be_bytes());
    for bytes in [
        thin[..16].to_vec(),
        library,
        truncated_commands,
        huge_arch_count,
        outside_slice,
    ] {
        std::fs::write(&entry, bytes).unwrap();
        assert!(fixture.install().is_err());
    }
}

#[test]
fn package_manifest_and_modules_symlinks_cannot_escape_owned_tree() {
    for subject in ["package", "manifest", "modules"] {
        let fixture = Fixture::new(":");
        let outside = fixture.directory.path().join("outside");
        std::fs::create_dir_all(outside.join("bin")).unwrap();
        std::fs::write(outside.join("package.json"), r#"{"bin":"bin/entry"}"#).unwrap();
        std::fs::write(outside.join("bin/entry"), "#!/usr/bin/env node\n").unwrap();
        let modules = fixture.root().join("node_modules");
        let package = modules.join("fixture");
        std::fs::create_dir_all(&package).unwrap();
        match subject {
            "package" => {
                std::fs::remove_dir(&package).unwrap();
                symlink(&outside, &package).unwrap();
            }
            "manifest" => {
                symlink(outside.join("package.json"), package.join("package.json")).unwrap()
            }
            _ => {
                std::fs::remove_dir_all(&modules).unwrap();
                symlink(&outside, &modules).unwrap();
            }
        }
        assert!(fixture.install().is_err(), "{subject}");
        assert_eq!(
            std::fs::read_to_string(outside.join("bin/entry")).unwrap(),
            "#!/usr/bin/env node\n"
        );
    }
}

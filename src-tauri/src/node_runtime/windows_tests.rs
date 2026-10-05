//! Windows installation launch mechanics; no package or Agent is installed.
use super::*;

#[test]
fn cancelled_node_zip_extraction_removes_the_unselected_candidate() {
    use std::cell::Cell;
    use std::io::Write;
    let directory = tempfile::tempdir().unwrap();
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("node/node.exe", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(&vec![7; 128 * 1024]).unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let calls = Cell::new(0);
    assert!(
        extract_node_archive(&bytes, directory.path(), || {
            calls.set(calls.get() + 1);
            if calls.get() >= 3 {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        })
        .is_err()
    );
    assert_eq!(calls.get(), 3);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn bundled_layout_and_npm_command_use_the_selected_node_and_js_entry() {
    let directory = tempfile::tempdir().unwrap();
    let (root, node, cli) = bundled_layout(directory.path());
    assert_eq!(node, root.join("node.exe"));
    assert_eq!(cli, root.join("node_modules/npm/bin/npm-cli.js"));
    let runtime = NodeRuntime {
        node: node.clone(),
        npm: NpmRunner::BundledCli {
            npm_cli: cli.clone(),
        },
        source: "fixture",
        version: None,
    };
    let command = runtime.npm_install_command("fixture@1.0.0", directory.path());
    assert_eq!(command.get_program(), node.as_os_str());
    assert_eq!(command.get_args().next(), Some(cli.as_os_str()));
    let path = command
        .get_envs()
        .find(|(key, _)| *key == "PATH")
        .unwrap()
        .1
        .unwrap();
    assert_eq!(std::env::split_paths(path).next().unwrap(), root);
    assert!(
        !command
            .get_args()
            .any(|arg| arg.to_string_lossy().ends_with(".cmd"))
    );
}

#[test]
fn npm_pe_entry_runs_directly_and_text_entry_keeps_the_selected_node() {
    let directory = tempfile::tempdir().unwrap();
    let node = directory.path().join("node.exe");
    let entry = directory.path().join("installed-agent.exe");
    std::fs::copy(crate::windows_process::helper_executable().unwrap(), &entry).unwrap();
    let native = npm_entry::launch(node.clone(), entry.clone()).unwrap();
    assert_eq!(native.command, entry);
    assert!(native.prefix_args.is_empty());
    let text = directory.path().join("entry-without-extension");
    std::fs::write(&text, "#!/usr/bin/env node\n// synthetic script\n").unwrap();
    let script = npm_entry::launch(node.clone(), text.clone()).unwrap();
    assert_eq!(script.command, node);
    assert_eq!(script.prefix_args, [text.to_string_lossy()]);
}

#[test]
fn malformed_pe_never_falls_back_to_node() {
    let directory = tempfile::tempdir().unwrap();
    let entry = directory.path().join("bad.exe");
    for bytes in [b"MZ".to_vec(), {
        let mut bytes = vec![0; 64];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes
    }] {
        std::fs::write(&entry, bytes).unwrap();
        assert!(npm_entry::launch(directory.path().join("node.exe"), entry.clone()).is_err());
    }
}

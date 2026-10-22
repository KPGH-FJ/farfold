//! Public ordinary-token retention on an owned NTFS repository. No privilege
//! adjustment, Agent, independent recovery package, or user repository is used.
use super::*;
use crate::{file_access::PinnedPath, meta_store::MetaStore, worktrees::*};
use std::{
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

const CREATE: &str = "11111111-1111-4111-8111-111111111111";
const ARCHIVE: &str = "22222222-2222-4222-8222-222222222222";
const RESTORE: &str = "33333333-3333-4333-8333-333333333333";

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git.exe")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "owned fixture Git failed: {args:?}"
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn wait(manager: &Worktrees, store: &MetaStore, id: &str) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let value = tests::op(manager.status(store, id).unwrap());
        if value.settled && !value.maintenance_active {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "operation did not settle: {value:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn prepare(manager: &Worktrees, store: &MetaStore, id: &str, preview: RecycleInspection) {
    let reply = manager
        .prepare_recycle(
            store,
            id,
            RecycleInput {
                inspection_id: preview.inspection_id,
                action: preview.action,
                expected_draft_baseline: preview.draft_baseline,
            },
            |_| Ok(()),
        )
        .unwrap();
    assert_eq!(tests::op(reply).state, "prepared");
}
fn identity(path: &Path, directory: bool) -> crate::file_access::Identity {
    let pin = if directory {
        PinnedPath::directory(path)
    } else {
        PinnedPath::regular(path)
    }
    .unwrap();
    pin.identity().clone()
}
fn set_ea(path: &Path) {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    };
    use windows_sys::{
        Wdk::Storage::FileSystem::NtSetEaFile,
        Win32::{
            Storage::FileSystem::{FILE_WRITE_EA, SYNCHRONIZE},
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let writer = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .open(path)
        .unwrap();
    let name = b"farfold-owned-archive";
    let value = b"retained\0EA\xff";
    let mut bytes = Vec::new();
    bytes.extend(0u32.to_le_bytes());
    bytes.extend([0, name.len() as u8]);
    bytes.extend((value.len() as u16).to_le_bytes());
    bytes.extend(name);
    bytes.push(0);
    bytes.extend(value);
    let mut status = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                writer.as_raw_handle(),
                &mut status,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
            )
        },
        0
    );
}

#[test]
fn public_ordinary_archive_cold_restore_preserves_owned_objects_and_readable_metadata() {
    let temporary = tempfile::tempdir().unwrap();
    let parent = PathBuf::from(inspect::canonical(temporary.path()).unwrap());
    let main = parent.join("owned main");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Fixture"),
        ("user.email", "fixture@example.invalid"),
        ("core.autocrlf", "false"),
    ] {
        git(&main, &["config", key, value]);
    }
    fs::write(main.join("payload.txt"), b"committed\n").unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-qm", "owned baseline"]);
    let head = git(&main, &["rev-parse", "HEAD"]);
    let database = parent.join("owned.sqlite");
    let store = MetaStore::open(&database).unwrap();
    let manager = Worktrees::default();
    let inspection = manager.inspect(&store, main.to_str().unwrap()).unwrap();
    let request = Create {
        inspection_id: inspection.inspection_id,
        parent_path: parent.to_str().unwrap().into(),
        directory_name: "owned linked".into(),
        branch: Branch::New {
            name: "retained-ordinary".into(),
            start_oid: head.clone(),
        },
    };
    assert_eq!(
        tests::op(manager.prepare(&store, CREATE, request).unwrap()).state,
        "prepared"
    );
    manager.start(&store, CREATE).unwrap();
    let created = wait(&manager, &store, CREATE);
    assert_eq!(created.state, "ready", "{created:?}");
    let location = created.location.unwrap();
    let linked = Path::new(&location.path);
    // Establish the actual condition: full-security access is unavailable but
    // the same ordinary object is readable. No token or DACL is changed.
    assert!(
        matches!(
            PinnedPath::directory_full_security(linked),
            Err(crate::file_access::FullSecurityFailure::AccessCondition { .. })
        ),
        "this control requires an ordinary token without full-security access"
    );
    fs::write(linked.join("payload.txt"), b"staged\n").unwrap();
    git(linked, &["add", "payload.txt"]);
    fs::write(linked.join("payload.txt"), b"dirty retained\n").unwrap();
    fs::write(linked.join(".gitignore"), b"ignored.bin\n").unwrap();
    fs::write(linked.join("ignored.bin"), b"ignored retained").unwrap();
    fs::write(linked.join("untracked.bin"), [0, 255, 3]).unwrap();
    fs::create_dir(linked.join("empty directory")).unwrap();
    fs::write(
        linked.join("payload.txt:retained:$DATA"),
        b"named stream retained",
    )
    .unwrap();
    set_ea(&linked.join("payload.txt"));
    let nodes = [
        ("", true),
        (".git", false),
        ("payload.txt", false),
        ("ignored.bin", false),
        ("untracked.bin", false),
        ("empty directory", true),
    ];
    let ids: Vec<_> = nodes
        .iter()
        .map(|(name, dir)| identity(&linked.join(name), *dir))
        .collect();
    let original = inspect::snapshot(linked).unwrap();
    let original_identity = storage::Identity::from(&original);
    // A saved full-security observation must still fail on this token rather
    // than quietly selecting the new ordinary observation after an error.
    assert_eq!(
        archive_material(
            &material_owner::Owner::default(),
            linked,
            &original.root_stamp,
            Some(&MaterialProfile::WindowsDefaultDataEaStreamsLinksFullSecurityV1),
            &AtomicBool::new(false),
        )
        .unwrap_err()
        .code,
        "securityAccessRequired",
    );
    let index = index_digest(&original_identity).unwrap();
    let main_index = fs::read(main.join(".git/index")).unwrap();
    let row = crate::acp_client::session_index::touch_session_row(
        &store,
        "fixture",
        &location.path,
        "native",
        Some("historical"),
        None,
    )
    .unwrap();
    let preview = manager
        .recycle_inspect(
            &store,
            RecycleAction::Archive,
            &location.id,
            location.revision,
        )
        .unwrap();
    assert!(preview.blockers.is_empty());
    assert_eq!(
        preview.material.profile,
        Some(MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1)
    );
    let expected = preview.material.clone();
    prepare(&manager, &store, ARCHIVE, preview);
    manager.start(&store, ARCHIVE).unwrap();
    let archived = wait(&manager, &store, ARCHIVE);
    assert_eq!(archived.state, "ready", "{archived:?}");
    let archive = archived.archive.unwrap();
    assert!(!linked.exists());
    let retained = Path::new(&archive.retained_path);
    for ((name, dir), id) in nodes.iter().zip(&ids) {
        assert_eq!(&identity(&retained.join(name), *dir), id);
    }
    assert_eq!(store.get_session(&row.id).unwrap().unwrap(), row);
    assert_eq!(index_digest(&original_identity).unwrap(), index);
    drop((manager, store));
    let store = MetaStore::open(&database).unwrap();
    let cold = Worktrees::default();
    let first = cold.list(&store).unwrap();
    assert_eq!(first.archives[0].availability, "unknown");
    assert!(
        cold.recycle_inspect(
            &store,
            RecycleAction::Restore,
            &archive.id,
            archive.revision
        )
        .is_err()
    );
    let checked = cold
        .recycle_check(&store, &archive.id, archive.revision)
        .unwrap();
    let archive = &checked.archives[0];
    assert_eq!(archive.availability, "verified");
    let preview = cold
        .recycle_inspect(
            &store,
            RecycleAction::Restore,
            &archive.id,
            archive.revision,
        )
        .unwrap();
    assert_eq!(preview.material, expected);
    prepare(&cold, &store, RESTORE, preview);
    cold.start(&store, RESTORE).unwrap();
    let restored = wait(&cold, &store, RESTORE);
    assert_eq!(restored.state, "ready", "{restored:?}");
    let final_location = restored.location.unwrap();
    assert_eq!(final_location.id, location.id);
    assert_eq!(final_location.path, location.path);
    for ((name, dir), id) in nodes.iter().zip(&ids) {
        assert_eq!(&identity(&linked.join(name), *dir), id);
    }
    assert!(!retained.exists());
    assert_eq!(
        fs::read(linked.join("payload.txt")).unwrap(),
        b"dirty retained\n"
    );
    assert_eq!(
        fs::read(linked.join("payload.txt:retained:$DATA")).unwrap(),
        b"named stream retained"
    );
    assert_eq!(fs::read(main.join(".git/index")).unwrap(), main_index);
    assert_eq!(index_digest(&original_identity).unwrap(), index);
    assert_eq!(store.get_session(&row.id).unwrap().unwrap(), row);
    let final_snapshot = inspect::snapshot(linked).unwrap();
    assert_eq!(final_snapshot.head, Some(head));
    assert_eq!(final_snapshot.branch, original.branch);
    assert_eq!(
        material_owner::Owner::default()
            .capture_archive(linked, &final_snapshot.root_stamp, &AtomicBool::new(false))
            .unwrap(),
        expected
    );
}

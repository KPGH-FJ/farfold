use super::*;
use std::os::unix::fs::PermissionsExt;
thread_local! {
    static LOCK_ATTEMPT: std::cell::RefCell<Option<Value>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn record_lock_attempt(file: &fs::File, meta: &fs::Metadata, result: Option<i32>) {
    // Capture errno before fcntl/metadata/formatting can replace it. Test-only, no paths.
    let errno = (result == Some(-1)).then(|| std::io::Error::last_os_error().raw_os_error());
    use std::os::fd::AsRawFd;
    let fd = file.as_raw_fd();
    LOCK_ATTEMPT.with(|slot| *slot.borrow_mut() = Some(json!({
        "pid":std::process::id(), "fd":fd, "fdFlags":unsafe {libc::fcntl(fd,libc::F_GETFD)},
        "regular":meta.is_file(), "device":meta.dev(), "inode":meta.ino(),
        "uid":meta.uid(), "euid":unsafe {libc::geteuid()}, "mode":meta.mode(), "links":meta.nlink(),
        "flockResult":result, "errno":errno
    })));
}
fn last_lock_attempt() -> Value {
    LOCK_ATTEMPT.with(|slot| slot.borrow().clone().unwrap_or(Value::Null))
}
mod lease_diagnostics;
fn registration() -> RuntimeRegistration {
    RuntimeRegistration {
        runtime_product_id: RuntimeProductId::parse("codex").unwrap(),
        display_name: "Codex".into(),
        installation_id: InstallationId::parse("owned-codex").unwrap(),
        runtime_build_id: RuntimeBuildId::parse(NATIVE_SHA).unwrap(),
        adapter_id: AdapterId::parse("codex-acp-stdio-v1").unwrap(),
        distribution: RuntimeDistribution::System,
        observed_version: "0.143.0".into(),
        artifact_sha256: NATIVE_SHA.into(),
        connection_id: ConnectionId::parse("owned-connection").unwrap(),
        connection_label: "Owned Codex".into(),
        connection_kind: RuntimeConnectionKind::SystemLocal,
        created_at: 1,
        verified_at: 1,
    }
}
fn profile() -> RuntimeOwnedProfile {
    let r = registration();
    RuntimeOwnedProfile {
        profile_id: RuntimeProfileId::parse("owned-profile").unwrap(),
        layout: OwnedProfileLayout::StableV1,
        binding: RuntimeBinding {
            product_id: r.runtime_product_id,
            installation_id: r.installation_id,
            runtime_build_id: r.runtime_build_id,
            adapter_id: r.adapter_id,
            connection_id: r.connection_id,
        },
        bootstrap_managed_provider: None,
    }
}
#[test]
fn shared_profile_launch_is_immutable_and_generations_survive_store_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("host.sqlite3");
    let store = HostStore::open(&db);
    let profile = profile();
    store
        .register_runtime_owned_profile(&registration(), &profile)
        .unwrap();
    let metadata = OwnedProfileLaunch {
        home: temp.path().join("owned-profile"),
        runtime_home: temp.path().join("owned-profile/codex"),
        node: "/synthetic/node".into(),
        adapter: "/synthetic/adapter".into(),
        native: "/synthetic/codex".into(),
        cwd: temp.path().into(),
        working_copy_id: WorkingCopyId::parse("workspace").unwrap(),
        adapter_version: ADAPTER_VERSION.into(),
        home_file_identity: [1, 2],
        runtime_home_file_identity: [1, 3],
        lease_file_identity: [1, 4],
        adapter_modules: BTreeMap::from([("adapter.mjs".into(), ADAPTER_SHA.into())]),
    };
    assert!(
        store
            .reserve_owned_profile_launch(&profile, &metadata, false)
            .is_err()
    );
    assert_eq!(
        store
            .reserve_owned_profile_launch(&profile, &metadata, true)
            .unwrap(),
        1
    );
    assert!(
        store
            .reserve_owned_profile_launch(&profile, &metadata, true)
            .is_err()
    );
    let mut changed = metadata.clone();
    changed.home = temp.path().join("foreign");
    assert!(
        store
            .reserve_owned_profile_launch(&profile, &changed, false)
            .is_err()
    );
    let mut replaced = metadata.clone();
    replaced.home_file_identity = [1, 9];
    assert!(
        store
            .reserve_owned_profile_launch(&profile, &replaced, false)
            .is_err()
    );
    let mut changed = metadata.clone();
    changed
        .adapter_modules
        .insert("adapter.mjs".into(), "changed".into());
    assert!(
        store
            .reserve_owned_profile_launch(&profile, &changed, false)
            .is_err()
    );
    let mut changed = metadata.clone();
    changed.working_copy_id = WorkingCopyId::parse("foreign").unwrap();
    assert!(
        store
            .reserve_owned_profile_launch(&profile, &changed, false)
            .is_err()
    );
    let mut foreign = profile.clone();
    foreign.binding.connection_id = ConnectionId::parse("foreign").unwrap();
    assert!(
        store
            .reserve_owned_profile_launch(&foreign, &metadata, false)
            .is_err()
    );
    drop(store);
    let reopened = HostStore::open(&db);
    confirm_original_launch(&reopened, &profile, &metadata, 1).unwrap();
    assert!(confirm_original_launch(&reopened, &profile, &changed, 1).is_err());
    assert_eq!(
        reopened
            .reserve_owned_profile_launch(&profile, &metadata, false)
            .unwrap(),
        2
    );
    // A queued restore must recheck this under its acquired lease, not reuse its lookup.
    assert!(confirm_original_launch(&reopened, &profile, &metadata, 1).is_err());
    confirm_original_launch(&reopened, &profile, &metadata, 2).unwrap();
    assert!(
        reopened
            .runtime_profile_provider_versions(&profile.binding)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn owned_directory_and_lease_reject_alias_permissions_and_concurrent_launch() {
    // A parallel test can fork while this process owns the FD; CLOEXEC does not
    // close the child's inherited reference until exec. Run these unchanged
    // last-reference assertions in a fresh exact-test process, before opening FD.
    const CHILD: &str = "FARFOLD_LEASE_ASSERTION_CHILD";
    if std::env::var_os(CHILD).as_deref() != Some(std::ffi::OsStr::new("1")) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "codex_acp::profile::tests::owned_directory_and_lease_reject_alias_permissions_and_concurrent_launch", "--test-threads=1", "--nocapture"])
            .env(CHILD, "1")
            .output().unwrap();
        assert!(
            output.status.success(),
            "isolated lease assertions failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "isolated exact test did not execute its assertions"
        );
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    private_directory(&root).unwrap();
    let first = lock_profile(&root, true).unwrap();
    assert!(lock_profile(&root, false).is_err());
    drop(first);
    drop(
        lock_profile(&root, false)
            .unwrap_or_else(|error| panic!("{error}; {:?}", last_lock_attempt())),
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(private_directory(&root).is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let alias = root.join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    assert!(private_directory(&alias).is_err());
    assert!(private_directory(&root.join("missing")).is_err());
}
#[test]
#[ignore = "explicit fixed Codex/Node, isolated empty profile restore only; zero login/model/thread mutation"]
fn fixed_owned_profile_restores_exact_home_with_persisted_generation_and_no_authorization() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let db = root.join("host.sqlite3");
    let store = HostStore::open(&db);
    let input = |create| {
        let r = registration();
        OwnedRequest {
            launch: Launch {
                node: std::env::var_os("FARFOLD_E_NODE")
                    .expect("explicit Node")
                    .into(),
                native: std::env::var_os("FARFOLD_E_CODEX")
                    .expect("explicit Codex")
                    .into(),
                adapter: Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("codex-acp-adapter/adapter.mjs"),
                owned_parent: root.clone(),
                cwd: root.clone(),
                working_copy_id: None,
                scope: Scope {
                    runtime_product_id: "codex".into(),
                    installation_id: r.installation_id.to_string(),
                    runtime_build_id: NATIVE_SHA.into(),
                    adapter_id: "codex-acp-stdio-v1".into(),
                    adapter_build_id: ADAPTER_SHA.into(),
                    connection_id: r.connection_id.to_string(),
                    profile_id: "owned-profile".into(),
                    generation: 1,
                },
            },
            registration: r,
            working_copy_id: WorkingCopyId::parse("owned-workspace").unwrap(),
            create,
        }
    };
    let runtime = configure::Runtime::default();
    let first = runtime.start_owned(&store, input(true)).unwrap();
    let other = configure::Runtime::default();
    assert!(other.start_owned(&store, input(false)).is_err());
    assert!(
        runtime
            .configure(
                &first,
                configure::CommandInput::Status {
                    operation_id: 1,
                    login_id: None
                }
            )
            .is_err()
    );
    let workspace = threads::Workspace {
        cwd: root.clone(),
        working_copy_id: Some(WorkingCopyId::parse("owned-workspace").unwrap()),
    };
    assert!(
        runtime
            .threads(&first, &workspace, threads::CommandInput::List)
            .unwrap()
            .data
            .is_empty()
    );
    runtime.stop(&first).unwrap();
    drop(runtime);
    drop(store);
    let reopened = HostStore::open(&db);
    let runtime = configure::Runtime::default();
    let next = runtime.start_owned(&reopened, input(false)).unwrap();
    assert!(next.generation > first.generation);
    assert_eq!(next.profile_id, first.profile_id);
    assert_eq!(next.connection_id, first.connection_id);
    assert!(runtime.read(&first, ReadMethod::Account).is_err());
    assert_eq!(
        runtime.read(&next, ReadMethod::Account).unwrap()["account"]["kind"],
        json!("unauthenticated")
    );
    assert!(
        runtime
            .threads(&next, &workspace, threads::CommandInput::List)
            .unwrap()
            .data
            .is_empty()
    );
    // Thread mutation is real now: without an admitted model selection the
    // start is rejected, and its unconfirmed outcome may retire the connection.
    assert!(
        runtime
            .threads(&next, &workspace, threads::CommandInput::Start)
            .is_err()
    );
    runtime.stop(&next).unwrap();
    for name in ["auth.json", "config.toml", "sessions"] {
        assert!(!root.join("owned-profile/codex").join(name).exists());
    }
    let mut foreign = input(false);
    foreign.launch.cwd = PathBuf::from("/");
    assert!(runtime.start_owned(&reopened, foreign).is_err());
    fs::set_permissions(
        root.join("owned-profile"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(runtime.start_owned(&reopened, input(false)).is_err());
}

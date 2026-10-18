//! Public synthetic package + real owned peer; never an installed Agent or history.
use super::*;
use std::path::PathBuf;

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    saved: source::Source,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let cwd = root.join("évidence with spaces");
        std::fs::create_dir(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let package = root.join("node_modules/@agentclientprotocol/codex-acp");
        let entry = package.join("dist/index.js");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(
            &entry,
            "// synthetic public entry; not JavaScript execution",
        )
        .unwrap();
        std::fs::write(
            package.join("package.json"),
            json!({"name":"@agentclientprotocol/codex-acp","version":"future-unselected-version","bin":{"codex-acp":"dist/index.js"}}).to_string(),
        ).unwrap();
        let expected = json!([
            entry.to_str().unwrap(),
            "cli",
            "app-server",
            "--listen",
            "stdio://"
        ]);
        let code = format!(
            "import sys,os\nsys.stdin.reconfigure(encoding='utf-8')\nsys.stdout.reconfigure(encoding='utf-8')\nassert sys.argv[1:]=={expected}\nsys.argv=[sys.argv[0],{},os.getcwd()]\n{}",
            json!(mode),
            include_str!("peer.py"),
        );
        let program = crate::platform_tests::python_peer(&root, "node", &code);
        let mut saved = source(cwd.to_str().unwrap());
        saved.agent.id = "registry:codex-acp".into();
        saved.agent.source = "registry".into();
        saved.agent.command = program.to_str().unwrap().into();
        saved.agent.args = vec![entry.to_str().unwrap().into()];
        saved.agent.version = Some("not-a-version-gate".into());
        saved.rows[0].agent_id = saved.agent.id.clone();
        // This independent precondition must pass even on the original history gate.
        assert!(inventory::launch::admission(&saved.agent).is_ok());
        Self {
            _temp: temp,
            root,
            saved,
        }
    }
    fn store(&self) -> MetaStore {
        let store = MetaStore::open(&self.root.join("meta.db")).unwrap();
        store.insert_agent(&self.saved.agent).unwrap();
        store.upsert_session(&self.saved.rows[0]).unwrap();
        store
    }
    fn run(&self) -> SearchOperation {
        let mut saved = self.saved.clone();
        saved.route = launch::admission(&saved.agent)
            .expect("reviewed selected Codex history must reach its read-only route");
        let store = self.store();
        let mut request = request();
        request.agent_id = saved.agent.id.clone();
        let (job, _) = requests::Requests::default()
            .begin(request, || Ok(saved))
            .unwrap();
        let outcome = query_with(&store, &job, |_, row| {
            // Actual reviewed command construction and current-dir selection. No service,
            // credentials or shell-env probe is needed for the owned synthetic peer.
            Ok(inventory::launch::command(
                &job.source.agent,
                &row.cwd,
                std::collections::HashMap::new(),
                inventory::Kind::Skills,
            )?)
        });
        job.finish(outcome.err().map(|error| error.code));
        job.snapshot()
    }
}

#[test]
fn reviewed_codex_history_uses_fixed_read_pages_and_preserves_source_offsets() {
    let fixture = Fixture::new("normal");
    let result = fixture.run();
    assert_eq!(result.state, State::Completed);
    assert_eq!(result.rows[0].state, RowState::Complete);
    assert_eq!(result.rows[0].pages_read, 2);
    assert_eq!(result.hits.len(), 2);
    assert!(result.hits.iter().all(|hit| hit.row_id == "saved-1"));
    assert_eq!(result.hits[0].matches, vec![Range { start: 3, end: 8 }]);
    assert_eq!(
        result.hits[0].locator,
        Locator::TurnItem {
            turn_id: "turn-1".into(),
            item_id: "u-1".into(),
            part_index: 1,
        }
    );
}

#[test]
fn reviewed_codex_history_rejects_wrong_native_id_and_different_cwd() {
    for mode in ["wrong", "wrong-cwd"] {
        let fixture = Fixture::new(mode);
        let result = fixture.run();
        assert_eq!(result.code, Some(Code::IndexChanged), "{mode}");
        assert_eq!(result.rows[0].state, RowState::Failed, "{mode}");
        assert!(result.hits.is_empty(), "{mode}");
    }
}

#[test]
fn reviewed_history_admission_does_not_broaden_unreviewed_launch_shapes() {
    let fixture = Fixture::new("normal");
    let mut row = fixture.saved.agent.clone();
    row.source = "custom".into();
    assert_eq!(
        launch::admission(&row).err().unwrap().code,
        Code::EntryUnverified
    );
    row = fixture.saved.agent.clone();
    row.args.push("unreviewed-wrapper-argument".into());
    assert_eq!(
        launch::admission(&row).err().unwrap().code,
        Code::EntryUnverified
    );
    row = fixture.saved.agent.clone();
    row.id = "registry:other-agent".into();
    assert_eq!(
        launch::admission(&row).err().unwrap().code,
        Code::NotReviewed
    );
    row = fixture.saved.agent.clone();
    row.env
        .push(("TOKEN".into(), crate::auth::KEYCHAIN_MARKER.into()));
    assert_eq!(
        launch::admission(&row).err().unwrap().code,
        Code::EnvironmentUnavailable
    );
}

#[cfg(windows)]
#[test]
fn windows_selected_history_capability_reaches_reviewed_official_route() {
    let fixture = Fixture::new("normal");
    let store = fixture.store();
    let manager = AcpManager::new(fixture.root.join("logs"), fixture.root.clone());
    let selection = source::capabilities(
        &store,
        &manager,
        &fixture.saved.agent.id,
        &["saved-1".into()],
    )
    .unwrap();
    assert_eq!(selection.availability, "available");
    assert_eq!(selection.source, Some("officialAppServer"));
    assert!(selection.selection_id.is_some());
    assert!(selection.code.is_none());
    assert_eq!(selection.rows[0].availability, "available");
    assert!(selection.rows[0].code.is_none());
}

#[cfg(windows)]
#[test]
fn windows_claude_sdk_history_remains_platform_unsupported() {
    let fixture = Fixture::new("normal");
    let mut row = fixture.saved.agent.clone();
    row.id = "registry:claude-acp".into();
    // Admission must reject this route before any SDK import or child starts.
    assert_eq!(
        launch::admission(&row).err().unwrap().code,
        Code::PlatformUnsupported
    );
}

use super::*;
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};

fn lease(id: &str) -> crate::install_job::Lease {
    crate::install_job::begin(id, tauri::ipc::Channel::new(|_| Ok(()))).unwrap()
}

fn executable(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn version_program(path: &Path, version: &str) {
    executable(path, &format!("#!/bin/sh\nprintf '%s\\n' '{version}'\n"));
}

fn environment(dirs: &[PathBuf]) -> HashMap<String, String> {
    HashMap::from([(
        "PATH".into(),
        std::env::join_paths(dirs)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    )])
}

fn package_fixture(venv: &Path, name: &str, version: &str) -> PathBuf {
    let script = venv.join("bin").join(name);
    executable(&script, "#!/bin/sh\nexit 0\n");
    let info = venv
        .join("lib/python3.12/site-packages")
        .join(format!("{}-{version}.dist-info", name.replace('-', "_")));
    std::fs::create_dir_all(&info).unwrap();
    std::fs::write(
        info.join("METADATA"),
        format!("Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n\nDescription\n"),
    )
    .unwrap();
    std::fs::write(
        info.join("entry_points.txt"),
        format!("[console_scripts]\n{name} = package.cli:run\n"),
    )
    .unwrap();
    script
}

fn uv_archive() -> (Vec<u8>, String) {
    use sha2::{Digest, Sha256};
    let mut tar = tar::Builder::new(Vec::new());
    let bytes = format!("#!/bin/sh\nprintf '%s\\n' 'uv {UV_VERSION}'\n");
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o755);
    tar.append_data(&mut header, "uv-aarch64-apple-darwin/uv", bytes.as_bytes())
        .unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(&tar.into_inner().unwrap()).unwrap();
    let bytes = gzip.finish().unwrap();
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    (bytes, digest)
}

#[test]
fn existing_tools_are_reused_and_old_python_does_not_meet_the_install_baseline() {
    let data = tempfile::tempdir().unwrap();
    let old = data.path().join("old-bin");
    let available = data.path().join("available-bin");
    version_program(&old.join("uv"), "uv 0.2.0");
    version_program(&old.join("python3"), "Python 3.9.6");
    version_program(&available.join("uv"), "uv 0.12.18 (official)");
    version_program(&available.join("python3.13"), "Python 3.13.8");
    let env = environment(&[old, available.clone()]);
    let (uv, python) = tools_in(data.path(), &env, &|| Ok(())).unwrap();
    assert_eq!(uv.unwrap().path, available.join("uv"));
    assert_eq!(python.unwrap().path, available.join("python3.13"));
    assert!(!data.path().join("uv").exists());
    assert!(!data.path().join("python").exists());
}

#[test]
fn missing_install_tools_do_not_block_existing_agent_use() {
    let dependencies = preparation_from_tools(Path::new("/owned"), None, None);
    assert_eq!(dependencies.len(), 2);
    for dependency in dependencies {
        assert!(matches!(dependency.status, DependencyStatus::Missing));
        assert!(dependency.required_for_install);
        assert!(!dependency.required_for_use);
        assert!(dependency.installable);
    }
}

#[test]
fn shared_managed_tools_are_discovered_without_changing_environment() {
    let data = tempfile::tempdir().unwrap();
    version_program(&uv_path(data.path()), "uv 0.12.18");
    version_program(&python_path(data.path()), "Python 3.12.13");
    let env = environment(&[]);
    let (uv, python) = tools_in(data.path(), &env, &|| Ok(())).unwrap();
    assert_eq!(uv.unwrap().path, uv_path(data.path()));
    assert_eq!(python.unwrap().path, python_path(data.path()));
    assert_eq!(env.len(), 1);
    let old = data.path().join("old-bin");
    version_program(&old.join("uv"), "uv 0.2.0");
    let (uv, _) = tools_in(data.path(), &environment(&[old]), &|| Ok(())).unwrap();
    assert_eq!(uv.unwrap().path, uv_path(data.path()));
    assert_eq!(
        usable_version("uv 0.2.37", false).as_deref(),
        Some("0.2.37")
    );
}

#[test]
fn installation_ignores_explicit_uv_config_but_keeps_home_and_existing_environment() {
    let env = HashMap::from([
        ("HOME".into(), "/users/existing".into()),
        ("PATH".into(), "/existing/bin".into()),
        (
            "UV_CONFIG_FILE".into(),
            "/users/existing/redirect.toml".into(),
        ),
    ]);
    let mut command = package_command_with_env(
        Path::new("/uv"),
        Path::new("/owned"),
        Path::new("/owned/agent"),
        env.clone(),
    );
    command.args([
        "pip",
        "install",
        "--python",
        "/owned/agent/venv/bin/python",
        "example-agent==0.1.44",
    ]);
    let changes = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_str().unwrap(),
                value.and_then(|value| value.to_str()),
            )
        })
        .collect::<HashMap<_, _>>();
    assert_eq!(changes["UV_CONFIG_FILE"], None);
    assert_eq!(changes["HOME"], Some("/users/existing"));
    assert_eq!(changes["PATH"], Some("/existing/bin"));
    assert_eq!(changes.len(), env.len());
    assert_eq!(
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        [
            "--no-config",
            "--no-python-downloads",
            "--cache-dir",
            "/owned/uv/cache",
            "pip",
            "install",
            "--python",
            "/owned/agent/venv/bin/python",
            "example-agent==0.1.44"
        ]
    );
    assert_eq!(env["UV_CONFIG_FILE"], "/users/existing/redirect.toml");
}

#[test]
fn prerequisites_cannot_create_directories_through_an_external_or_broken_symlink() {
    let data = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    symlink(external.path(), data.path().join("uv")).unwrap();
    assert!(owned_parent(data.path(), &data.path().join("uv/cache")).is_err());
    assert!(!external.path().join("cache").exists());
    let broken = data.path().join("broken");
    symlink(data.path().join("missing"), &broken).unwrap();
    assert!(path_present(&broken).unwrap());
    assert!(owned_parent(data.path(), &broken.join("cache")).is_err());
    assert!(!data.path().join("missing").exists());
}

#[test]
fn verified_tool_is_published_atomically_and_existing_root_is_preserved() {
    let data = tempfile::tempdir().unwrap();
    let (bytes, digest) = uv_archive();
    let first = lease("uv-tool-publish-first");
    publish_tool(
        data.path(),
        &uv_root(data.path()),
        &bytes,
        &digest,
        "uv-aarch64-apple-darwin",
        ("uv", false),
        &first.job,
    )
    .unwrap();
    let previous = std::fs::read(uv_path(data.path())).unwrap();
    let second = lease("uv-tool-publish-existing");
    assert!(
        publish_tool(
            data.path(),
            &uv_root(data.path()),
            &bytes,
            &digest,
            "uv-aarch64-apple-darwin",
            ("uv", false),
            &second.job
        )
        .is_err()
    );
    assert_eq!(std::fs::read(uv_path(data.path())).unwrap(), previous);
    assert_eq!(
        std::fs::read_dir(data.path().join("uv")).unwrap().count(),
        1
    );
}

#[test]
fn cancelled_or_bad_digest_runtime_never_publishes_a_candidate() {
    let data = tempfile::tempdir().unwrap();
    let (bytes, digest) = uv_archive();
    let cancelled = lease("uv-tool-publish-cancel");
    crate::install_job::agent_install_cancel("uv-tool-publish-cancel".into()).unwrap();
    assert!(
        publish_tool(
            data.path(),
            &uv_root(data.path()),
            &bytes,
            &digest,
            "uv-aarch64-apple-darwin",
            ("uv", false),
            &cancelled.job
        )
        .is_err()
    );
    let corrupt = lease("uv-tool-publish-corrupt");
    assert!(
        publish_tool(
            data.path(),
            &uv_root(data.path()),
            &bytes,
            "incorrect",
            "uv-aarch64-apple-darwin",
            ("uv", false),
            &corrupt.job
        )
        .is_err()
    );
    assert!(!data.path().join("uv").exists());
}

#[test]
fn unrelated_large_metadata_and_target_description_do_not_block_official_console_script() {
    let data = tempfile::tempdir().unwrap();
    let venv = data.path().join("venv");
    let script = package_fixture(&venv, "fast-agent-acp", "0.10.1");
    let site = venv.join("lib/python3.12/site-packages");
    let unrelated = site.join("other_package-1.0.dist-info");
    std::fs::create_dir(&unrelated).unwrap();
    std::fs::write(
        unrelated.join("METADATA"),
        vec![b'x'; (METADATA_LIMIT * 2) as usize],
    )
    .unwrap();
    let target = site.join("fast_agent_acp-0.10.1.dist-info/METADATA");
    let mut metadata = std::fs::read(&target).unwrap();
    metadata.extend(vec![b'x'; (METADATA_LIMIT * 2) as usize]);
    std::fs::write(target, metadata).unwrap();
    let job = lease("uv-agent-console-large-metadata");
    assert_eq!(
        console_script(
            &venv,
            &UvxPackage::parse("fast-agent-acp==0.10.1").unwrap(),
            &job.job
        )
        .unwrap(),
        script.canonicalize().unwrap()
    );
}

#[test]
fn wrong_version_or_undeclared_console_script_cannot_become_selected_launch_target() {
    let data = tempfile::tempdir().unwrap();
    let venv = data.path().join("venv");
    package_fixture(&venv, "example-agent", "0.1.43");
    let job = lease("uv-agent-console-version");
    assert!(
        console_script(
            &venv,
            &UvxPackage::parse("example-agent@0.1.44").unwrap(),
            &job.job
        )
        .is_err()
    );
    let script = package_fixture(&venv, "example-agent", "0.1.44");
    let info = venv.join("lib/python3.12/site-packages/example_agent-0.1.44.dist-info");
    std::fs::write(
        info.join("entry_points.txt"),
        "[console_scripts]\nother = package.cli:run\n",
    )
    .unwrap();
    std::fs::remove_dir_all(
        venv.join("lib/python3.12/site-packages/example_agent-0.1.43.dist-info"),
    )
    .unwrap();
    assert!(
        console_script(
            &venv,
            &UvxPackage::parse("example-agent@0.1.44").unwrap(),
            &job.job
        )
        .is_err()
    );
    assert!(script.is_file());
}

#[test]
fn console_script_cannot_escape_venv_or_launch_without_executable_permissions() {
    let data = tempfile::tempdir().unwrap();
    let venv = data.path().join("venv");
    let script = package_fixture(&venv, "example-agent", "0.1.44");
    let job = lease("uv-agent-console-boundary");
    let package = UvxPackage::parse("example-agent@0.1.44").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(console_script(&venv, &package, &job.job).is_err());
    std::fs::remove_file(&script).unwrap();
    let external = data.path().join("external");
    executable(&external, "#!/bin/sh\nexit 0\n");
    symlink(&external, &script).unwrap();
    assert!(console_script(&venv, &package, &job.job).is_err());
    assert_eq!(
        std::fs::read_to_string(external).unwrap(),
        "#!/bin/sh\nexit 0\n"
    );
}

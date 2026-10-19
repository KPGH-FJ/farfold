//! A complete, bounded local bundle plus actual recovery in an independent repo.
//! It never adds refs/config/index entries to the source repository.
#[cfg(unix)]
use super::checkout::Checkout;
use super::{
    git,
    inspect::{self, Snapshot, Stamp},
    material_scan,
    recovery_roots::{self, MAX_BYTES, MAX_OBJECTS, Roots},
    recycle_types::MaterialSummary,
    remove_types::Recovery,
    storage::SavedArchive,
    types::*,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};
#[path = "recovery_artifact.rs"]
mod artifact;
#[cfg(windows)]
#[path = "private_offline_graph_windows.rs"]
mod offline_graph;
#[cfg(windows)]
#[path = "private_bare_windows.rs"]
mod private_bare;
#[cfg(windows)]
#[path = "private_bundle_graph_windows.rs"]
pub(super) mod private_graph;
use artifact::Artifacts;
pub(super) use artifact::FileIdentity;
pub(super) const COMMAND_TIME: Duration = Duration::from_secs(120);
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub version: u32,
    pub roots: Roots,
    pub objects: Vec<String>,
    pub content: MaterialSummary,
    pub configs: Vec<String>,
    pub attributes: Vec<u8>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedRecovery {
    pub operation_id: String,
    pub source: SavedArchive,
    pub receipt: Recovery,
    pub parent: String,
    pub parent_stamp: Stamp,
    pub directory_stamp: Stamp,
    pub bundle_stamp: FileIdentity,
    pub manifest_stamp: FileIdentity,
    #[cfg(windows)]
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "super::windows_offline_program::deserialize_optional"
    )]
    pub windows_program_origin: Option<super::windows_offline_program::Origin>,
}
fn private_command(root: &Path, args: &[&str]) -> Result<Command> {
    let mut c = git::command(root, args)?;
    c.env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1");
    Ok(c)
}
fn run(c: Command, bytes: Option<&[u8]>, cancel: &AtomicBool) -> Result<Vec<u8>> {
    // MAX_ROOTS/MAX_OBJECTS with admitted SHA1/SHA256 OIDs fit the existing
    // output budget. This is not a new cap on user material or pack payload.
    let input = match bytes {
        Some(bytes) => git::Input::from_bytes(bytes, git::OUTPUT_LIMIT, cancel)?,
        None => git::Input::null(),
    };
    run_input(c, input, cancel)
}
fn run_input(c: Command, input: git::Input, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let o = git::execute_command_input(c, input, cancel, COMMAND_TIME)?;
    if !o.success {
        return Err(error("recoveryInvalid"));
    }
    Ok(o.bytes)
}
fn private(
    root: &Path,
    args: &[&str],
    bytes: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    run(private_command(root, args)?, bytes, cancel)
}
fn text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| error("recoveryInvalid"))
}
fn objects(c: Command, roots: &Roots, cancel: &AtomicBool) -> Result<Vec<String>> {
    let raw = text(run(c, Some(&roots.input()), cancel)?)?;
    let mut set = BTreeSet::new();
    for line in raw.lines() {
        if !oid(line) || line.len() != roots.head.len() || !set.insert(line.to_owned()) {
            return Err(error("recoveryInvalid"));
        }
    }
    if set.len() > MAX_OBJECTS {
        return Err(error("recoveryLimit"));
    }
    Ok(set.into_iter().collect())
}
pub(super) fn capture(s: &Snapshot, cancel: &AtomicBool) -> Result<Manifest> {
    #[cfg(windows)]
    let source_graph = git::source_roots::SourceGraph::capture(s, cancel)?;
    #[cfg(windows)]
    let roots = source_graph.roots().clone();
    #[cfg(windows)]
    let o = source_graph.objects().to_vec();
    #[cfg(unix)]
    let roots = recovery_roots::capture(s, cancel)?;
    let root = Path::new(&s.root);
    #[cfg(unix)]
    let o = {
        let o = objects(
            git::command(
                root,
                &["rev-list", "--objects", "--no-object-names", "--stdin"],
            )?,
            &roots,
            cancel,
        )?;
        let sizes = text(run(
            git::command(
                root,
                &[
                    "cat-file",
                    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                ],
            )?,
            Some((o.join("\n") + "\n").as_bytes()),
            cancel,
        )?)?;
        let mut bytes = 0u64;
        if sizes.lines().count() != o.len() {
            return Err(error("recoveryInvalid"));
        }
        for (line, wanted) in sizes.lines().zip(&o) {
            let fields: Vec<_> = line.split(' ').collect();
            if fields.len() != 3
                || fields[0] != wanted
                || !matches!(fields[1], "commit" | "tree" | "blob" | "tag")
            {
                return Err(error("recoveryInvalid"));
            }
            bytes = bytes
                .checked_add(
                    fields[2]
                        .parse::<u64>()
                        .map_err(|_| error("recoveryInvalid"))?,
                )
                .ok_or(error("recoveryLimit"))?;
            if bytes > MAX_BYTES {
                return Err(error("recoveryLimit"));
            }
        }
        o
    };
    // Compare an actual clean checkout, including effective safe EOL attributes.
    // Git status alone is insufficient for assume-unchanged/ignored material.
    #[cfg(unix)]
    let profile = Checkout::prepare(s, &roots.head)?;
    #[cfg(unix)]
    let (configs, attributes) = profile.recovery_profile()?;
    #[cfg(windows)]
    let (configs, attributes) = source_graph.checkout_profile(cancel)?;
    let content = material_scan::content(root, cancel)?;
    #[cfg(windows)]
    source_graph.recheck(cancel)?;
    Ok(Manifest {
        version: 1,
        roots,
        objects: o,
        content,
        configs,
        attributes,
    })
}
fn init(root: &Path, format: &str, bare: bool, cancel: &AtomicBool) -> Result<()> {
    fs::create_dir(root).map_err(|_| error("targetExists"))?;
    initialize(root, format, bare, cancel)
}
fn initialize(root: &Path, format: &str, bare: bool, cancel: &AtomicBool) -> Result<()> {
    let flag = format!("--object-format={format}");
    let mut args = vec!["init", "--template=", flag.as_str()];
    if bare {
        args.push("--bare");
    }
    private(root, &args, None, cancel)?;
    Ok(())
}
fn refs(m: &Manifest) -> Vec<(String, String)> {
    m.roots
        .commits
        .iter()
        .enumerate()
        .map(|(i, oid)| (oid.clone(), format!("refs/heads/recovery/root-{i:04}")))
        .collect()
}
fn install_refs(root: &Path, m: &Manifest, cancel: &AtomicBool) -> Result<()> {
    for (oid, name) in refs(m) {
        private(root, &["update-ref", &name, &oid], None, cancel)?;
    }
    let head = refs(m)
        .into_iter()
        .find(|(oid, _)| oid == &m.roots.head)
        .ok_or(error("recoveryInvalid"))?
        .1;
    private(root, &["symbolic-ref", "HEAD", &head], None, cancel)?;
    Ok(())
}
fn verify_objects(root: &Path, m: &Manifest, cancel: &AtomicBool) -> Result<()> {
    private(
        root,
        &[
            "fsck",
            "--full",
            "--strict",
            "--no-reflogs",
            "--no-dangling",
        ],
        None,
        cancel,
    )?;
    let actual = objects(
        private_command(
            root,
            &["rev-list", "--objects", "--no-object-names", "--stdin"],
        )?,
        &m.roots,
        cancel,
    )?;
    if actual != m.objects {
        return Err(error("recoveryInvalid"));
    }
    Ok(())
}
fn checkout(root: &Path, m: &Manifest, cancel: &AtomicBool) -> Result<()> {
    let info = root.join(".git/info");
    fs::create_dir_all(&info).map_err(|_| error("unavailable"))?;
    fs::write(info.join("attributes"), &m.attributes).map_err(|_| error("unavailable"))?;
    let mut args = vec![
        "-c".to_string(),
        "core.attributesFile=/dev/null".into(),
        "-c".into(),
        "checkout.workers=1".into(),
    ];
    for config in &m.configs {
        args.extend(["-c".into(), config.clone()]);
    }
    args.extend(["reset".into(), "--hard".into(), m.roots.head.clone()]);
    private(
        root,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        None,
        cancel,
    )?;
    if material_scan::content(root, cancel)? != m.content {
        return Err(error("uncommittedMaterial"));
    }
    Ok(())
}
fn validate(m: &Manifest) -> Result<()> {
    if m.version != 1
        || m.content.profile.is_some()
        || !matches!(m.roots.format.as_str(), "sha1" | "sha256")
        || !oid(&m.roots.head)
        || m.roots.commits.is_empty()
        || m.roots.commits.len() > recovery_roots::MAX_ROOTS
        || !m.roots.commits.contains(&m.roots.head)
        || m.objects.len() > MAX_OBJECTS
        || !m
            .roots
            .commits
            .iter()
            .chain(&m.objects)
            .all(|v| oid(v) && v.len() == m.roots.head.len())
        || m.attributes.len() > 4 * 1024 * 1024
        || m.configs.len() > 9
    {
        return Err(error("recoveryInvalid"));
    }
    let mut names = BTreeSet::new();
    for config in &m.configs {
        let (name, value) = config.split_once('=').ok_or(error("recoveryInvalid"))?;
        let valid = match name {
            "core.autocrlf" => matches!(value, "true" | "false" | "input"),
            "core.safecrlf" => matches!(value, "true" | "false" | "warn"),
            "core.eol" => matches!(value, "lf" | "crlf" | "native"),
            "core.symlinks"
            | "core.filemode"
            | "core.ignorecase"
            | "core.precomposeunicode"
            | "core.protecthfs"
            | "core.protectntfs" => matches!(value, "true" | "false"),
            _ => false,
        };
        if !valid || !names.insert(name) {
            return Err(error("recoveryInvalid"));
        }
    }
    Ok(())
}
pub(super) fn recover_into(
    bundle: &Path,
    m: &Manifest,
    target: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    validate(m)?;
    init(target, &m.roots.format, false, cancel)?;
    populate(bundle, m, target, cancel)
}
pub(super) fn recover_reserved(
    bundle: &Path,
    m: &Manifest,
    target: &Path,
    stamp: &Stamp,
    cancel: &AtomicBool,
) -> Result<()> {
    validate(m)?;
    inspect::same(target.to_str().ok_or(error("unsafePath"))?, stamp)?;
    if fs::read_dir(target)
        .map_err(|_| error("unavailable"))?
        .next()
        .is_some()
    {
        return Err(error("targetExists"));
    }
    initialize(target, &m.roots.format, false, cancel)?;
    populate(bundle, m, target, cancel)
}
fn populate(bundle: &Path, m: &Manifest, target: &Path, cancel: &AtomicBool) -> Result<()> {
    let bundle = bundle.to_str().ok_or(error("unsafePath"))?;
    private(target, &["bundle", "verify", bundle], None, cancel)?;
    let output = text(private(
        target,
        &["bundle", "unbundle", bundle],
        None,
        cancel,
    )?)?;
    let mut expected = refs(m);
    expected.push((m.roots.head.clone(), "HEAD".into()));
    expected.sort();
    let mut actual = Vec::new();
    for line in output.lines() {
        let (oid, name) = line.split_once(' ').ok_or(error("recoveryInvalid"))?;
        actual.push((oid.to_owned(), name.to_owned()));
    }
    actual.sort();
    if actual != expected {
        return Err(error("recoveryInvalid"));
    }
    install_refs(target, m, cancel)?;
    verify_objects(target, m, cancel)?;
    checkout(target, m, cancel)?;
    // Only the newly created independent repository receives its verified safe checkout profile.
    for entry in &m.configs {
        let (key, value) = entry.split_once('=').ok_or(error("recoveryInvalid"))?;
        private(target, &["config", "--local", key, value], None, cancel)?;
    }
    private(
        target,
        &["config", "--local", "core.attributesFile", "/dev/null"],
        None,
        cancel,
    )?;
    verify_restored(target, m, cancel)
}
pub(super) fn expected_branch(m: &Manifest) -> Result<String> {
    refs(m)
        .into_iter()
        .find(|(o, _)| o == &m.roots.head)
        .map(|(_, n)| n)
        .ok_or(error("recoveryInvalid"))
}
pub(super) fn verify_restored(target: &Path, m: &Manifest, cancel: &AtomicBool) -> Result<()> {
    validate(m)?;
    if target.join(".git/objects/info/alternates").exists() || target.join(".git/shallow").exists()
    {
        return Err(error("recoveryInvalid"));
    }
    verify_objects(target, m, cancel)?;
    let raw = text(private(
        target,
        &["for-each-ref", "--format=%(objectname) %(refname)"],
        None,
        cancel,
    )?)?;
    let mut actual = raw
        .lines()
        .map(|l| {
            l.split_once(' ')
                .map(|(o, n)| (o.to_owned(), n.to_owned()))
                .ok_or(error("recoveryChanged"))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut wanted = refs(m);
    actual.sort();
    wanted.sort();
    if actual != wanted {
        return Err(error("recoveryChanged"));
    }
    if text(private(target, &["rev-parse", "HEAD"], None, cancel)?)?.trim() != m.roots.head
        || text(private(target, &["symbolic-ref", "HEAD"], None, cancel)?)?.trim()
            != expected_branch(m)?
        || material_scan::content(target, cancel)? != m.content
    {
        return Err(error("recoveryChanged"));
    }
    Ok(())
}
fn create_file(path: &Path) -> Result<File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    o.open(path).map_err(|_| error("targetExists"))
}
pub(super) fn digest(path: &Path, cap: u64) -> Result<(u64, String)> {
    let mut o = fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut f = o.open(path).map_err(|_| error("recoveryChanged"))?;
    let s = crate::file_access::stamp(&f).map_err(|_| error("recoveryChanged"))?;
    if !f
        .metadata()
        .map_err(|_| error("recoveryChanged"))?
        .is_file()
        || s.size > cap
    {
        return Err(error("recoveryLimit"));
    }
    let mut sha = Sha256::new();
    let mut count = 0;
    let mut buffer = [0u8; 65536];
    loop {
        let n = f.read(&mut buffer).map_err(|_| error("unavailable"))?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > s.size {
            return Err(error("recoveryChanged"));
        }
        sha.update(&buffer[..n]);
    }
    if count != s.size || crate::file_access::stamp(&f).map_err(|_| error("recoveryChanged"))? != s
    {
        return Err(error("recoveryChanged"));
    }
    Ok((count, material_scan::hex(sha.finalize())))
}
pub(super) fn publish_bundle(source: &Path, destination: &Path, cancel: &AtomicBool) -> Result<()> {
    let expected = digest(source, MAX_BYTES)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut source = options.open(source).map_err(|_| error("recoveryChanged"))?;
    let before = crate::file_access::stamp(&source).map_err(|_| error("recoveryChanged"))?;
    if !source
        .metadata()
        .map_err(|_| error("recoveryChanged"))?
        .is_file()
        || before.size != expected.0
    {
        return Err(error("recoveryChanged"));
    }
    let mut output = create_file(destination)?;
    let mut sha = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        let n = source.read(&mut buffer).map_err(|_| error("unavailable"))?;
        if n == 0 {
            break;
        }
        count += n as u64;
        if count > expected.0 {
            return Err(error("recoveryChanged"));
        }
        sha.update(&buffer[..n]);
        output
            .write_all(&buffer[..n])
            .map_err(|_| error("unavailable"))?;
    }
    if (count, material_scan::hex(sha.finalize())) != expected
        || crate::file_access::stamp(&source).map_err(|_| error("recoveryChanged"))? != before
    {
        return Err(error("recoveryChanged"));
    }
    output.sync_all().map_err(|_| error("unavailable"))
}
#[cfg(windows)]
pub(super) struct ExportRequest<'a> {
    identity: &'a super::storage::Identity,
    retained: &'a str,
    manifest: &'a Manifest,
}
#[cfg(windows)]
impl<'a> ExportRequest<'a> {
    // The private constructor is reachable only from this existing consumer
    // and its test module; a Roots value or arbitrary byte slice is not authority.
    fn new(
        identity: &'a super::storage::Identity,
        retained: &'a str,
        manifest: &'a Manifest,
    ) -> Result<Self> {
        validate(manifest)?;
        let width = match manifest.roots.format.as_str() {
            "sha1" => 40,
            "sha256" => 64,
            _ => return Err(error("recoveryInvalid")),
        };
        if manifest.roots.head.len() != width {
            return Err(error("recoveryInvalid"));
        }
        Ok(Self {
            identity,
            retained,
            manifest,
        })
    }
    pub(super) fn identity(&self) -> &super::storage::Identity {
        self.identity
    }
    pub(super) fn retained(&self) -> &str {
        self.retained
    }
    pub(super) fn roots_input(&self) -> Vec<u8> {
        self.manifest.roots.input()
    }
}
#[cfg(windows)]
struct WindowsFirst {
    // Field drop order is intentional: Imported closes its source/pack pins
    // before the export namespace's held directory and TempDir are removed.
    imported: private_bare::Imported,
    export_namespace: git::source_export::Namespace,
}
#[cfg(windows)]
impl WindowsFirst {
    fn path(&self) -> &Path {
        self.imported.path()
    }
}
#[cfg(windows)]
fn windows_first(request: ExportRequest<'_>, cancel: &AtomicBool) -> Result<WindowsFirst> {
    let manifest = request.manifest;
    let identity = request.identity;
    let retained = request.retained;
    let exported = git::source_export::export(request, cancel)?;
    let (source, pack, namespace) = exported.into_parts()?;
    let imported = private_bare::import(source, identity, retained, pack, manifest, cancel)?;
    let first = WindowsFirst {
        imported,
        export_namespace: namespace,
    };
    first.export_namespace.verify()?;
    Ok(first)
}

pub(super) fn build(
    operation_id: &str,
    saved: &SavedArchive,
    m: &Manifest,
    id: &str,
    path: &Path,
    reserved_stamp: &Stamp,
    cancel: &AtomicBool,
) -> Result<SavedRecovery> {
    validate(m)?;
    let parent = path.parent().ok_or(error("unsafePath"))?;
    if parent != Path::new(&saved.parent) {
        return Err(error("unsafePath"));
    }
    inspect::same(&saved.parent, &saved.parent_stamp)?;
    inspect::same(path.to_str().ok_or(error("unsafePath"))?, reserved_stamp)?;
    if fs::read_dir(path)
        .map_err(|_| error("unavailable"))?
        .next()
        .is_some()
    {
        return Err(error("targetExists"));
    }
    let directory_stamp = reserved_stamp.clone();
    let temp = tempfile::tempdir_in(path).map_err(|_| error("unavailable"))?;
    #[cfg(unix)]
    let pack = temp.path().join("objects.pack");
    #[cfg(unix)]
    {
        let cmd = git::command(
            Path::new(&saved.archive.retained_path),
            &[
                "-c",
                "pack.threads=1",
                "-c",
                "pack.windowMemory=16m",
                "pack-objects",
                "--stdout",
                "--revs",
            ],
        )?;
        let input = git::Input::from_bytes(&m.roots.input(), git::OUTPUT_LIMIT, cancel)?;
        if !git::execute_to_file(
            cmd,
            input,
            cancel,
            COMMAND_TIME,
            create_file(&pack)?,
            MAX_BYTES,
        )?
        .success
        {
            return Err(error("recoveryInvalid"));
        }
    }
    #[cfg(unix)]
    let first = temp.path().join("first");
    #[cfg(unix)]
    {
        init(&first, &m.roots.format, true, cancel)?;
        let cmd = private_command(
            &first,
            &[
                "index-pack",
                "--stdin",
                "--strict",
                "--max-input-size=268435456",
            ],
        )?;
        // This used to configure a File then run(None). Preserve that real file
        // input explicitly; None now means Null only for callers with no payload.
        let input = git::Input::from_file(
            File::open(&pack).map_err(|_| error("unavailable"))?,
            MAX_BYTES,
            cancel,
        )?;
        run_input(cmd, input, cancel)?;
        install_refs(&first, m, cancel)?;
        verify_objects(&first, m, cancel)?;
    }
    #[cfg(windows)]
    let first_owner = windows_first(
        ExportRequest::new(&saved.original.identity, &saved.archive.retained_path, m)?,
        cancel,
    )?;
    #[cfg(unix)]
    let first = first.as_path();
    #[cfg(unix)]
    let staged_bundle = temp.path().join("verified.bundle");
    #[cfg(unix)]
    {
        private(
            first,
            &[
                "bundle",
                "create",
                "--version=3",
                staged_bundle.to_str().ok_or(error("unsafePath"))?,
                "--all",
            ],
            None,
            cancel,
        )?;
        // The generator writes only its fresh private staging directory. Final publication
        // is create_new: even a late external same-name file must never be overwritten.
        recover_into(&staged_bundle, m, &temp.path().join("second"), cancel)?;
    }
    #[cfg(windows)]
    let mut graph_owner = private_graph::generate(&first_owner, m, cancel)?;
    #[cfg(windows)]
    // Graph validity never substitutes for the existing full material path.
    recover_into(graph_owner.path()?, m, &temp.path().join("second"), cancel)?;
    #[cfg(windows)]
    graph_owner.recheck(cancel)?;
    #[cfg(windows)]
    let staged_bundle = graph_owner.path()?;
    inspect::same(&saved.parent, &saved.parent_stamp)?;
    inspect::same(path.to_str().ok_or(error("unsafePath"))?, reserved_stamp)?;
    let bundle = path.join("recovery.bundle");
    #[cfg(unix)]
    publish_bundle(&staged_bundle, &bundle, cancel)?;
    #[cfg(windows)]
    publish_bundle(staged_bundle, &bundle, cancel)?;
    let manifest = path.join("manifest.json");
    let raw = serde_json::to_vec(m).map_err(|_| error("recoveryInvalid"))?;
    if raw.len() > 16 * 1024 * 1024 {
        return Err(error("recoveryLimit"));
    }
    let mut f = create_file(&manifest)?;
    f.write_all(&raw)
        .and_then(|_| f.sync_all())
        .map_err(|_| error("unavailable"))?;
    // The writer must close before acquiring Windows read-only artifact pins;
    // otherwise the unchanged FILE_SHARE_READ correctly denies this open.
    drop(f);
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| error("unavailable"))?;
    let mut artifacts =
        Artifacts::open(path, parent, &saved.parent_stamp, &directory_stamp, cancel)?;
    let observed = artifacts.observe(cancel)?;
    if observed.manifest_raw != raw {
        return Err(error("recoveryChanged"));
    }
    let a = &saved.archive;
    let receipt = Recovery {
        id: id.into(),
        revision: 0,
        archive_id: a.id.clone(),
        archive_revision: a.revision,
        original_path: a.original_path.clone(),
        retained_path: a.retained_path.clone(),
        repository_root: a.repository_root.clone(),
        head_oid: a.head_oid.clone(),
        branch: a.branch.clone(),
        path: path.to_str().ok_or(error("unsafePath"))?.into(),
        bundle_bytes: observed.bundle_bytes,
        bundle_sha256: observed.bundle_sha256,
        manifest_sha256: observed.manifest_sha256,
        roots_sha256: m.roots.summary()?.sha256,
        content_sha256: m.content.sha256.clone(),
        root_count: m.roots.commits.len() as u64,
        object_count: m.objects.len() as u64,
        object_format: m.roots.format.clone(),
        availability: "verified".into(),
    };
    inspect::same(&saved.parent, &saved.parent_stamp)?;
    inspect::same(path.to_str().ok_or(error("unsafePath"))?, &directory_stamp)?;
    Ok(SavedRecovery {
        operation_id: operation_id.into(),
        source: saved.clone(),
        receipt,
        parent: parent.to_str().ok_or(error("unsafePath"))?.into(),
        parent_stamp: saved.parent_stamp.clone(),
        directory_stamp,
        bundle_stamp: observed.bundle_identity,
        manifest_stamp: observed.manifest_identity,
        #[cfg(windows)]
        windows_program_origin: Some({
            let origin = first_owner.imported.offline_program_origin()?;
            origin.matches(&saved.original.identity, &saved.archive.retained_path)?;
            origin
        }),
    })
}
pub(super) fn verify(saved: &SavedRecovery, cancel: &AtomicBool) -> Result<Manifest> {
    let r = &saved.receipt;
    let root = Path::new(&r.path);
    inspect::same(&saved.parent, &saved.parent_stamp)?;
    inspect::same(&r.path, &saved.directory_stamp)?;
    let mut artifacts = Artifacts::open(
        root,
        Path::new(&saved.parent),
        &saved.parent_stamp,
        &saved.directory_stamp,
        cancel,
    )?;
    let expected = artifact::Expected {
        bundle_identity: &saved.bundle_stamp,
        manifest_identity: &saved.manifest_stamp,
        bundle_bytes: r.bundle_bytes,
        bundle_sha256: &r.bundle_sha256,
        manifest_sha256: &r.manifest_sha256,
    };
    let observed = artifacts.read_verified(&expected, cancel)?;
    let m: Manifest =
        serde_json::from_slice(&observed.manifest_raw).map_err(|_| error("recoveryInvalid"))?;
    let bundle = artifacts.bundle_path();
    validate(&m)?;
    if m.roots.summary()?.sha256 != r.roots_sha256
        || m.content.sha256 != r.content_sha256
        || m.roots.head != r.head_oid
        || m.roots.format != r.object_format
        || m.objects.len() as u64 != r.object_count
        || m.roots.commits.len() as u64 != r.root_count
    {
        return Err(error("recoveryInvalid"));
    }
    #[cfg(windows)]
    // Additional Git-graph evidence only. Full material restoration below is
    // still required, with every existing Manifest1/profile/mutation gate.
    offline_graph::verify(saved, &mut artifacts, &m, cancel)?;
    let t = tempfile::tempdir().map_err(|_| error("unavailable"))?;
    recover_into(
        &bundle,
        &m,
        &t.path()
            .canonicalize()
            .map_err(|_| error("unavailable"))?
            .join("verified"),
        cancel,
    )?;
    if artifacts.read_verified(&expected, cancel)? != observed {
        return Err(error("recoveryChanged"));
    }
    inspect::same(&saved.parent, &saved.parent_stamp)?;
    inspect::same(&r.path, &saved.directory_stamp)?;
    Ok(m)
}

#[cfg(test)]
#[test]
fn manifest_v1_rejects_partial_windows_content_before_any_filesystem_work() {
    use super::recycle_types::MaterialProfile;
    let head = "a".repeat(40);
    let mut manifest = Manifest {
        version: 1,
        roots: Roots {
            head: head.clone(),
            format: "sha1".into(),
            commits: vec![head.clone()],
            files: Vec::new(),
        },
        objects: vec![head],
        content: MaterialSummary {
            profile: None,
            entries: 0,
            bytes: 0,
            sha256: "b".repeat(64),
        },
        configs: Vec::new(),
        attributes: Vec::new(),
    };
    validate(&manifest).unwrap();
    for profile in [
        MaterialProfile::WindowsDefaultDataV1,
        MaterialProfile::WindowsDefaultDataEaV1,
        MaterialProfile::WindowsDefaultDataEaStreamsV1,
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclV1,
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksV1,
        MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1,
        MaterialProfile::WindowsDefaultDataEaStreamsLinksFullSecurityV1,
    ] {
        manifest.content.profile = Some(profile);
        assert_eq!(validate(&manifest).unwrap_err().code, "recoveryInvalid");
    }
}

#[cfg(all(windows, test))]
#[path = "source_pack_windows_tests.rs"]
mod source_export_tests;

// Persistent body capability, not a new Manifest version/public restore gate.
#[cfg(all(windows, test))]
#[path = "recovery_material_windows.rs"]
pub(super) mod material;

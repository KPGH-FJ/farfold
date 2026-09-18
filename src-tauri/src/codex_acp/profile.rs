//! Uses shared installation/connection/profile storage; no private profile registry.
use super::*;
use crate::{
    host_ids::*,
    host_store::{HostStore, records::*, runtime_owned_profile::*},
    runtime_registry::RuntimeBinding,
};
use std::{collections::BTreeMap, os::unix::fs::MetadataExt, path::Path};

pub struct OwnedRequest {
    pub launch: Launch,
    pub registration: RuntimeRegistration,
    pub working_copy_id: WorkingCopyId,
    pub create: bool,
}

pub(super) fn private_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Original owned directory missing")?;
    if !path.is_absolute()
        || !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || path
            .canonicalize()
            .map_err(|_| "Owned directory unavailable")?
            != path
    {
        return Err("Unsafe or foreign owned directory".into());
    }
    Ok(())
}

pub(super) fn prepare(
    store: &HostStore,
    input: OwnedRequest,
) -> Result<(Launch, fs::File), String> {
    prepare_checked(store, input, None)
}

pub(super) fn prepare_restore(
    store: &HostStore,
    input: OwnedRequest,
    expected_generation: u64,
) -> Result<(Launch, fs::File), String> {
    if input.create {
        return Err("Restore cannot create a profile".into());
    }
    prepare_checked(store, input, Some(expected_generation))
}

fn prepare_checked(
    store: &HostStore,
    mut input: OwnedRequest,
    expected_generation: Option<u64>,
) -> Result<(Launch, fs::File), String> {
    input.launch.scope.validate()?;
    verify_files(&input.launch)?;
    let scope = &input.launch.scope;
    let registration = &input.registration;
    let binding = RuntimeBinding {
        product_id: RuntimeProductId::parse(&scope.runtime_product_id)
            .map_err(|e| e.to_string())?,
        installation_id: InstallationId::parse(&scope.installation_id)
            .map_err(|e| e.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(&scope.runtime_build_id)
            .map_err(|e| e.to_string())?,
        adapter_id: AdapterId::parse(&scope.adapter_id).map_err(|e| e.to_string())?,
        connection_id: ConnectionId::parse(&scope.connection_id).map_err(|e| e.to_string())?,
    };
    let profile = RuntimeOwnedProfile {
        profile_id: RuntimeProfileId::parse(&scope.profile_id).map_err(|e| e.to_string())?,
        layout: OwnedProfileLayout::StableV1,
        binding,
        bootstrap_managed_provider: None,
    };
    profile.validate()?;
    if registration.runtime_product_id != profile.binding.product_id
        || registration.installation_id != profile.binding.installation_id
        || registration.runtime_build_id != profile.binding.runtime_build_id
        || registration.adapter_id != profile.binding.adapter_id
        || registration.connection_id != profile.binding.connection_id
        || registration.distribution != RuntimeDistribution::System
        || registration.connection_kind != RuntimeConnectionKind::SystemLocal
        || registration.observed_version != "0.143.0"
        || registration.artifact_sha256 != NATIVE_SHA
    {
        return Err("Codex owned registration differs from fixed launch".into());
    }
    private_directory(&input.launch.owned_parent)?;
    let home = input.launch.owned_parent.join(profile.profile_id.as_str());
    let runtime_home = home.join("codex");
    if input
        .launch
        .owned_parent
        .components()
        .any(|part| part.as_os_str() == ".codex")
    {
        return Err("Default Codex domain cannot become an owned profile".into());
    }
    if !input.launch.cwd.is_dir()
        || input
            .launch
            .cwd
            .canonicalize()
            .map_err(|_| "Working Copy missing")?
            != input.launch.cwd
    {
        return Err("Working Copy path is not exact".into());
    }
    let mut metadata = OwnedProfileLaunch {
        home: home.clone(),
        runtime_home: runtime_home.clone(),
        node: input.launch.node.clone(),
        adapter: input.launch.adapter.clone(),
        native: input.launch.native.clone(),
        cwd: input.launch.cwd.clone(),
        working_copy_id: input.working_copy_id.clone(),
        adapter_version: ADAPTER_VERSION.into(),
        home_file_identity: [0, 0],
        runtime_home_file_identity: [0, 0],
        lease_file_identity: [0, 0],
        adapter_modules: BTreeMap::from([
            ("adapter.mjs".into(), ADAPTER_SHA.into()),
            ("core.mjs".into(), CORE_SHA.into()),
            ("configure.mjs".into(), CONFIGURE_SHA.into()),
            ("threads.mjs".into(), THREADS_SHA.into()),
            ("events.mjs".into(), EVENTS_SHA.into()),
            ("turns.mjs".into(), TURNS_SHA.into()),
            ("interactions.mjs".into(), INTERACTIONS_SHA.into()),
            ("admission.mjs".into(), ADMISSION_SHA.into()),
        ]),
    };
    // Reuse the Codex-specific schema-8 launch format so peer readers remain valid.
    let inspection = crate::codex_installation::inspect(input.launch.native.clone())?;
    if input.create {
        if store.runtime_owned_profile(&profile.binding)?.is_some()
            || home.try_exists().map_err(|_| "Owned path unavailable")?
        {
            return Err("Owned profile already exists; no implicit replacement".into());
        }
        store.accept_system_installation(registration, &inspection)?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&home)
            .map_err(|_| "Cannot create private profile")?;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&runtime_home)
            .map_err(|_| "Cannot create private runtime home")?;
        store.register_runtime_owned_profile(registration, &profile)?;
    } else {
        private_directory(&home)?;
        private_directory(&runtime_home)?;
        let installations = store.system_installations()?;
        let saved = installations
            .iter()
            .find(|i| i.installation_id == profile.binding.installation_id)
            .ok_or("Original system installation missing")?;
        if saved.runtime_build_id != profile.binding.runtime_build_id
            || !saved.inspection.same_location(&inspection)
        {
            return Err("Original system installation changed".into());
        }
    }
    // Never inspect credential contents. Creation still requires an empty
    // authentication domain; a restored owned profile legitimately holds the
    // native state this connection produced across earlier launches.
    for name in ["auth.json", "config.toml", "sessions"] {
        match fs::symlink_metadata(runtime_home.join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(meta) if !input.create => {
                if !meta.is_dir() && !meta.is_file() {
                    return Err("Owned native state is not a regular file/directory".into());
                }
            }
            _ => return Err("Owned profile already contains native state".into()),
        }
    }
    let lease = lock_profile(&home, input.create)?;
    let identity = |meta: fs::Metadata| [meta.dev(), meta.ino()];
    metadata.home_file_identity =
        identity(fs::symlink_metadata(&home).map_err(|_| "Owned home missing")?);
    metadata.runtime_home_file_identity =
        identity(fs::symlink_metadata(&runtime_home).map_err(|_| "Owned runtime home missing")?);
    metadata.lease_file_identity = identity(lease.metadata().map_err(|_| "Owned lease missing")?);
    // Recheck after acquiring the original lease, before advancing a generation.
    if let Some(generation) = expected_generation {
        confirm_original_launch(store, &profile, &metadata, generation)?;
    }
    input.launch.scope.generation =
        store.reserve_owned_profile_launch(&profile, &metadata, input.create)?;
    input.launch.working_copy_id = Some(input.working_copy_id);
    Ok((input.launch, lease))
}

fn confirm_original_launch(
    store: &HostStore,
    profile: &RuntimeOwnedProfile,
    metadata: &OwnedProfileLaunch,
    generation: u64,
) -> Result<(), String> {
    if store.current_owned_profile_launch(&profile.binding, &profile.profile_id, generation)?
        != *metadata
    {
        return Err("Original owned launch changed".into());
    }
    Ok(())
}

fn lock_profile(home: &Path, create: bool) -> Result<fs::File, String> {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(home.join(".farfold-launch.lock"))
        .map_err(|_| "Original private launch lock missing or unsafe")?;
    let meta = file.metadata().map_err(|_| "Launch lock unavailable")?;
    let safe_metadata = meta.is_file()
        && meta.nlink() == 1
        && meta.uid() == unsafe { libc::geteuid() }
        && meta.mode() & 0o077 == 0;
    // Preserve short-circuiting and the public error. Diagnostics exist only in tests.
    let lock_result = safe_metadata
        .then(|| unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) });
    #[cfg(test)]
    tests::record_lock_attempt(&file, &meta, lock_result);
    if lock_result != Some(0) {
        return Err("Owned profile already active or launch lock unsafe".into());
    }
    Ok(file)
}

#[cfg(test)]
mod tests;

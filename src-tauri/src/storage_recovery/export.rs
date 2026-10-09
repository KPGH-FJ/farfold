use super::{MetaStore, StorageIssue, existing_material, io_receipt};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReceipt {
    pub path: String,
    pub kind: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFailure {
    pub issue: StorageIssue,
    pub partial_path: Option<String>,
}
impl ExportFailure {
    pub(super) fn new(reason: &str, path: Option<&Path>) -> Self {
        Self {
            issue: StorageIssue::from_receipt(reason),
            partial_path: path.map(|path| path.to_string_lossy().into_owned()),
        }
    }
}

#[derive(Serialize, PartialEq, Eq)]
struct FileReceipt {
    name: String,
    bytes: u64,
    sha256: String,
}

fn fingerprint(path: &Path) -> Result<FileReceipt, String> {
    let meta = path.symlink_metadata().map_err(io_receipt)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("恢复材料不是可复制的普通文件".into());
    }
    let mut source = File::open(path).map_err(io_receipt)?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 65536];
    loop {
        let count = source.read(&mut buffer).map_err(io_receipt)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
    }
    Ok(FileReceipt {
        name: path
            .file_name()
            .ok_or("无法读取恢复材料名称")?
            .to_string_lossy()
            .into_owned(),
        bytes,
        sha256: hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    })
}
fn sources(path: &Path) -> Result<Vec<PathBuf>, String> {
    let paths = existing_material(path)?;
    if paths.is_empty() {
        return Err("FARFOLD_STORAGE:missing:原位置没有可复制的资料文件".into());
    }
    Ok(paths)
}
fn unique_directory(parent: &Path) -> Result<PathBuf, String> {
    if !parent.is_dir() {
        return Err("请选择可以写入的文件夹".into());
    }
    tempfile::Builder::new()
        .prefix("Farfold-Recovery-")
        .tempdir_in(parent)
        .map(|directory| directory.keep())
        .map_err(io_receipt)
}
fn copy_new(source: &Path, destination: &Path) -> Result<(), String> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(io_receipt)?;
    let mut input = File::open(source).map_err(io_receipt)?;
    std::io::copy(&mut input, &mut output).map_err(io_receipt)?;
    output.sync_all().map_err(io_receipt)
}

pub(super) fn export(
    path: &Path,
    store: Option<&MetaStore>,
    parent: &Path,
) -> Result<ExportReceipt, ExportFailure> {
    // Every destination is newly owned. Never overwrite or remove existing user files.
    let directory = unique_directory(parent).map_err(|reason| ExportFailure::new(&reason, None))?;
    let result = (|| {
        let (kind, files) = if let Some(store) = store {
            let target = directory.join("farfold.sqlite3");
            store.export_snapshot(&target)?;
            ("snapshot", vec![fingerprint(&target)?])
        } else {
            let paths = sources(path)?;
            let before = paths
                .iter()
                .map(|path| fingerprint(path))
                .collect::<Result<Vec<_>, _>>()?;
            for source in &paths {
                copy_new(
                    source,
                    &directory.join(source.file_name().ok_or("无法读取恢复材料名称")?),
                )?;
            }
            let after_paths = sources(path)?;
            let after = after_paths
                .iter()
                .map(|path| fingerprint(path))
                .collect::<Result<Vec<_>, _>>()?;
            let copied = paths
                .iter()
                .map(|path| fingerprint(&directory.join(path.file_name().unwrap())))
                .collect::<Result<Vec<_>, _>>()?;
            if before != after || before != copied {
                return Err("资料在复制过程中发生变化，副本尚未确认，请重试".into());
            }
            ("unverifiedFiles", copied)
        };
        let manifest = serde_json::json!({"version":1,"kind":kind,"files":files,"containsPrivateData":true,"includesAgentHistory":false});
        complete_manifest(&directory, &manifest)?;
        Ok(ExportReceipt {
            path: directory.to_string_lossy().into_owned(),
            kind,
        })
    })();
    // Failed exports may contain useful material. Keep it and identify it.
    // A final directory-sync failure can leave recovery.json in place. The
    // manifest describes verified bytes; only an Ok command receipt confirms
    // this export's durability. Any later restore must revalidate the files.
    result.map_err(|reason: String| ExportFailure::new(&reason, Some(&directory)))
}

pub(super) fn complete_manifest(
    directory: &Path,
    manifest: &serde_json::Value,
) -> Result<(), String> {
    let mut receipt = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(directory.join("recovery.incomplete.json"))
        .map_err(io_receipt)?;
    receipt
        .write_all(
            serde_json::to_string_pretty(manifest)
                .map_err(|_| "无法记录恢复副本")?
                .as_bytes(),
        )
        .map_err(io_receipt)?;
    receipt.sync_all().map_err(io_receipt)?;
    drop(receipt);
    fs::rename(
        directory.join("recovery.incomplete.json"),
        directory.join("recovery.json"),
    )
    .map_err(io_receipt)?;
    #[cfg(unix)]
    File::open(directory)
        .and_then(|dir| dir.sync_all())
        .map_err(io_receipt)?;
    Ok(())
}

use super::*;

fn allowed_names(path: &Path) -> Result<Vec<String>, Failure> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Failure::new("blocked"))?;
    Ok(["", "-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| format!("{name}{suffix}"))
        .collect())
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_fact(f: &Fact) -> bool {
    f.bytes <= LIMIT && hex(&f.sha256, 64)
}
pub(super) fn read_intent(path: &Path) -> Result<Option<Intent>, Failure> {
    let record = record(path)?;
    if !files::exists(&record)? {
        return Ok(None);
    }
    files::directory(parent(path)?)?;
    let intent: Intent = serde_json::from_slice(&files::small_file(&record, 65536)?)
        .map_err(|_| Failure::new("blocked"))?;
    let names = allowed_names(path)?;
    let mut seen = std::collections::HashSet::new();
    if intent.version != 1
        || !hex(&intent.id, 48)
        || !valid_fact(&intent.database)
        || intent.database.bytes < 100
        || intent.originals.len() > 4
        || intent
            .originals
            .iter()
            .try_fold(0u64, |sum, entry| sum.checked_add(entry.fact.bytes))
            .is_none_or(|sum| sum > LIMIT)
        || intent.originals.iter().any(|entry| {
            !names.contains(&entry.name) || !seen.insert(&entry.name) || !valid_fact(&entry.fact)
        })
    {
        return Err(Failure::new("blocked"));
    }
    Ok(Some(intent))
}
pub(super) fn save(
    path: &Path,
    intent: &Intent,
    replace: bool,
    io: &impl FileOps,
) -> Result<(), Failure> {
    if replace {
        let previous = read_intent(path)?.ok_or_else(|| Failure::new("changed"))?;
        if previous.id != intent.id
            || previous.database != intent.database
            || previous.originals != intent.originals
        {
            return Err(Failure::new("changed"));
        }
    }
    let bytes = serde_json::to_vec_pretty(intent).map_err(|_| Failure::new("unavailable"))?;
    io.save_record(&record(path)?, &bytes, replace)
}
fn current_originals(path: &Path) -> Result<Vec<Original>, Failure> {
    crate::storage_recovery::existing_material(path)
        .map_err(Failure::storage)?
        .into_iter()
        .map(|file| {
            Ok(Original {
                name: file
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or_else(|| Failure::new("unsupported"))?
                    .to_string(),
                fact: files::fact(&file)?,
            })
        })
        .collect()
}
pub(super) fn preparation_untouched(path: &Path, intent: &Intent) -> Result<(), Failure> {
    if intent.phase != Phase::Preparing || current_originals(path)? != intent.originals {
        return Err(Failure::new("changed"));
    }
    let retained = work(path, &intent.id)?.join("original");
    if files::exists(&retained)? {
        files::directory(&retained)?;
        if std::fs::read_dir(&retained)
            .map_err(files::storage)?
            .next()
            .is_some()
        {
            return Err(Failure::new("changed"));
        }
    }
    Ok(())
}
pub(super) fn prepare(path: &Path, pending: &Pending, io: &impl FileOps) -> Result<(), Failure> {
    files::directory(parent(path)?)?;
    if read_intent(path)? != pending.previous || files::fact(&pending.snapshot)? != pending.fact {
        return Err(Failure::new("changed"));
    }
    if let Some(old) = pending
        .previous
        .as_ref()
        .filter(|i| i.phase == Phase::Preparing)
    {
        preparation_untouched(path, old)?;
    }
    validate::database(&pending.snapshot)?;
    let original = current_originals(path)?;
    if original.iter().map(|o| o.fact.bytes).sum::<u64>() > LIMIT {
        return Err(Failure::new("tooLarge"));
    }
    let mut intent = Intent {
        version: 1,
        id: pending.preview.id.clone(),
        phase: Phase::Preparing,
        originals: original,
        database: pending.fact.clone(),
    };
    let root = container(path)?;
    let folder = work(path, &pending.preview.id)?;
    let result = (|| {
        // First intent is durable before the sentinel directory. A failed
        // preparation can be recognized after restart; originals are untouched.
        if pending.previous.is_none() {
            let bytes =
                serde_json::to_vec_pretty(&intent).map_err(|_| Failure::new("unavailable"))?;
            io.save_record(&record(path)?, &bytes, false)?;
        }
        if files::exists(&root)? {
            files::directory(&root)?;
        } else {
            files::private_directory(&root)?;
            io.sync_directory(parent(path)?)?;
        }
        files::private_directory(&folder)?;
        if let Some(previous) = &pending.previous {
            let bytes = serde_json::to_vec_pretty(previous).map_err(|_| Failure::new("blocked"))?;
            io.save_record(&folder.join("previous-receipt.json"), &bytes, false)?;
            io.sync_directory(&root)?;
            if read_intent(path)? != pending.previous {
                return Err(Failure::new("changed"));
            }
            let bytes =
                serde_json::to_vec_pretty(&intent).map_err(|_| Failure::new("unavailable"))?;
            io.save_record(&record(path)?, &bytes, true)?;
        }
        files::private_directory(&folder.join("protected"))?;
        files::private_directory(&folder.join("original"))?;
        for file in &intent.originals {
            if files::copy(
                &parent(path)?.join(&file.name),
                &folder.join("protected").join(&file.name),
            )? != file.fact
            {
                return Err(Failure::new("changed"));
            }
        }
        if current_originals(path)? != intent.originals {
            return Err(Failure::new("changed"));
        }
        // A complete, separately retained byte copy precedes every original move.
        io.sync_directory(&folder.join("protected"))?;
        files::copy(&pending.snapshot, &folder.join("candidate.sqlite3"))?;
        validate::database(&folder.join("candidate.sqlite3"))?;
        io.sync_directory(&folder.join("original"))?;
        io.sync_directory(&folder)?;
        io.sync_directory(&root)?;
        io.sync_directory(parent(path)?)?;
        intent.phase = Phase::Prepared;
        save(path, &intent, true, io)
    })();
    result.map_err(|mut failure: Failure| {
        failure.materials_path = files::exists(&folder)
            .ok()
            .filter(|exists| *exists)
            .map(|_| text(&folder));
        failure.materials_complete = false;
        failure
    })
}
fn protected(path: &Path, intent: &Intent) -> Result<PathBuf, Failure> {
    let folder = work(path, &intent.id)?;
    for dir in [&folder, &folder.join("protected"), &folder.join("original")] {
        files::directory(dir)?;
    }
    for original in &intent.originals {
        if files::fact(&folder.join("protected").join(&original.name))? != original.fact {
            return Err(Failure::new("changed"));
        }
    }
    Ok(folder)
}
pub(super) fn installed(path: &Path, intent: &Intent) -> Result<(), Failure> {
    let folder = protected(path, intent)?;
    for original in &intent.originals {
        if files::fact(&folder.join("original").join(&original.name))? != original.fact {
            return Err(Failure::new("changed"));
        }
    }
    if files::exists(&folder.join("candidate.sqlite3"))? {
        return Err(Failure::new("changed"));
    }
    for name in allowed_names(path)?.into_iter().skip(1) {
        if files::exists(&parent(path)?.join(name))? {
            return Err(Failure::new("changed"));
        }
    }
    if files::fact(path)? != intent.database {
        return Err(Failure::new("changed"));
    }
    Ok(())
}
fn resumable(path: &Path, intent: &Intent) -> Result<(), Failure> {
    let folder = protected(path, intent)?;
    if !files::exists(&folder.join("candidate.sqlite3"))? {
        return installed(path, intent);
    }
    if files::fact(&folder.join("candidate.sqlite3"))? != intent.database {
        return Err(Failure::new("changed"));
    }
    for name in allowed_names(path)? {
        let live = parent(path)?.join(&name);
        let retained = folder.join("original").join(&name);
        let expected = intent.originals.iter().find(|o| o.name == name);
        match (expected, files::exists(&live)?, files::exists(&retained)?) {
            (Some(original), true, false) if files::fact(&live)? == original.fact => {}
            (Some(original), false, true) if files::fact(&retained)? == original.fact => {}
            (None, false, false) => {}
            _ => return Err(Failure::new("changed")),
        }
    }
    Ok(())
}
pub(super) fn status(path: &Path, intent: &Intent) -> Result<Status, Failure> {
    let folder = work(path, &intent.id)?;
    Ok(Status {
        id: Some(intent.id.clone()),
        phase: match intent.phase {
            Phase::Preparing => "preparing",
            Phase::Prepared => "pending",
            Phase::Installed => "installed",
            Phase::Released => "released",
        },
        protected_path: if intent.phase == Phase::Preparing {
            None
        } else {
            Some(text(&folder.join("protected")))
        },
        retained_path: if intent.phase == Phase::Preparing {
            files::exists(&folder)?.then(|| text(&folder))
        } else {
            Some(text(&folder.join("original")))
        },
        can_continue: intent.phase == Phase::Prepared,
        can_restart: intent.phase == Phase::Installed,
    })
}
pub(super) fn inspect_intent(path: &Path, intent: &Intent) -> Result<Status, Failure> {
    match intent.phase {
        Phase::Preparing => preparation_untouched(path, intent)?,
        Phase::Prepared => resumable(path, intent)?,
        Phase::Installed => installed(path, intent)?,
        Phase::Released => {}
    }
    status(path, intent)
}
pub(super) fn advance(path: &Path, id: &str, io: &impl FileOps) -> Result<Status, Failure> {
    let mut intent = read_intent(path)?
        .filter(|i| i.id == id)
        .ok_or_else(|| Failure::new("expired"))?;
    if intent.phase != Phase::Prepared {
        return inspect_intent(path, &intent);
    }
    let folder = work(path, id)?;
    let result = (|| {
        resumable(path, &intent)?;
        if files::exists(&folder.join("candidate.sqlite3"))? {
            for original in &intent.originals {
                let source = parent(path)?.join(&original.name);
                let retained = folder.join("original").join(&original.name);
                if files::exists(&source)? {
                    if files::fact(&source)? != original.fact {
                        return Err(Failure::new("changed"));
                    }
                    io.move_new(&source, &retained)?;
                    io.sync_directory(&folder.join("original"))?;
                    io.sync_directory(parent(path)?)?;
                    if files::fact(&retained)? != original.fact {
                        return Err(Failure::new("changed"));
                    }
                }
            }
            resumable(path, &intent)?;
            io.move_new(&folder.join("candidate.sqlite3"), path)?;
            io.sync_directory(&folder)?;
            io.sync_directory(parent(path)?)?;
        }
        installed(path, &intent)?;
        validate::captured_database(path)?;
        installed(path, &intent)?;
        intent.phase = Phase::Installed;
        save(path, &intent, true, io)?;
        status(path, &intent)
    })();
    result.map_err(|mut failure: Failure| {
        failure.materials_path = Some(text(&folder));
        failure.materials_complete = true;
        failure
    })
}

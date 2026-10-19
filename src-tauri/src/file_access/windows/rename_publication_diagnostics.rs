//! Test-only selected primitive matrix. No production fallback or retry.
use super::super::{TemporaryExport, handle, name, open_at, open_directory, open_relative, stamp};
use serde_json::json;
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
    mem::{align_of, offset_of, size_of},
    path::Path,
    ptr,
};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_RENAME_INFORMATION, FileRenameInformation, NtSetInformationFile,
    },
    Win32::{
        Foundation::{
            ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND, RtlNtStatusToDosError,
        },
        Storage::FileSystem::{FILE_RENAME_INFO, FileRenameInfo, SetFileInformationByHandle},
        System::IO::IO_STATUS_BLOCK,
    },
};

#[derive(Clone, Copy)]
enum Variant {
    OriginalLeaf,
    ShortExact,
    Win32Nul,
    Win32Struct,
    Win32Aligned,
    NtStruct,
}
impl Variant {
    fn label(self) -> &'static str {
        match self {
            Self::OriginalLeaf => "production_original_leaf",
            Self::ShortExact => "production_short_exact",
            Self::Win32Nul => "win32_name_plus_nul",
            Self::Win32Struct => "win32_struct_plus_name",
            Self::Win32Aligned => "win32_allocation_extent",
            Self::NtStruct => "nt_struct_plus_name",
        }
    }
    fn leaf(self) -> &'static str {
        if matches!(self, Self::OriginalLeaf) {
            "published.txt"
        } else {
            "out.txt"
        }
    }
}
fn phase<T>(v: Variant, collision: bool, phase: &str, result: io::Result<T>) -> io::Result<T> {
    let error = result.as_ref().err();
    eprintln!(
        "FARFOLD_RENAME_PRIMITIVE {}",
        json!({
            "variant":v.label(),"collision":collision,"phase":phase,"ok":result.is_ok(),
            "ioKind":error.map(|e|format!("{:?}",e.kind())),"rawOsCode":error.and_then(io::Error::raw_os_error)
        })
    );
    result
}
fn need<T>(result: io::Result<T>) -> T {
    result.unwrap_or_else(|_| panic!("owned primitive precondition/check failed; see fixed phase"))
}
fn body(file: &mut File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    Read::by_ref(file).take(65).read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn manual(v: Variant, collision: bool, temporary: &TemporaryExport) -> io::Result<()> {
    let destination = name(OsStr::new(v.leaf()))?;
    let name_bytes = destination.len() * 2;
    let offset = offset_of!(FILE_RENAME_INFO, FileName);
    let exact = offset + name_bytes;
    let count = match v {
        Variant::Win32Nul => exact + 2,
        Variant::Win32Struct | Variant::NtStruct => size_of::<FILE_RENAME_INFO>() + name_bytes,
        Variant::Win32Aligned => (exact + 2).div_ceil(size_of::<usize>()) * size_of::<usize>(),
        _ => unreachable!("production variants use the actual method"),
    };
    // Explicit NUL lives within every manual variant's passed length. Flags and
    // all padding stay zero, including ReplaceIfExists=false. Filename length
    // always excludes NUL and remains the identical seven-unit relative leaf.
    let mut allocation = vec![0usize; count.div_ceil(size_of::<usize>())];
    assert!(count >= exact + 2);
    eprintln!(
        "FARFOLD_RENAME_PRIMITIVE {}",
        json!({
            "variant":v.label(),"collision":collision,"phase":"layout", "nameUnits":destination.len(),
            "nameBytes":name_bytes,"fileNameOffset":offset,"structBytes":size_of::<FILE_RENAME_INFO>(),
            "alignment":align_of::<FILE_RENAME_INFO>(),"passedBytes":count,
            "allocationBytes":allocation.len()*size_of::<usize>(),"relativeRootNonNull":true,"replace":false
        })
    );
    if matches!(v, Variant::NtStruct) {
        assert_eq!(offset_of!(FILE_RENAME_INFORMATION, FileName), offset);
        assert_eq!(
            size_of::<FILE_RENAME_INFORMATION>(),
            size_of::<FILE_RENAME_INFO>()
        );
        let rename = allocation.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*rename).RootDirectory = handle(&temporary.directory);
            (*rename).FileNameLength = name_bytes as u32;
            ptr::copy_nonoverlapping(
                destination.as_ptr(),
                (*rename).FileName.as_mut_ptr(),
                destination.len(),
            );
        }
        let mut iosb = IO_STATUS_BLOCK::default();
        // TemporaryExport::create uses NtCreateFile with SYNCHRONIZE and
        // FILE_SYNCHRONOUS_IO_NONALERT. This is a synchronous file-object call;
        // no async buffer/IO owner or independent filesystem worker is created.
        let code = unsafe {
            NtSetInformationFile(
                handle(&temporary.file),
                &mut iosb,
                rename.cast(),
                count as u32,
                FileRenameInformation,
            )
        };
        let mapped = if code == 0 {
            None
        } else {
            Some(unsafe { RtlNtStatusToDosError(code) })
        };
        eprintln!(
            "FARFOLD_RENAME_PRIMITIVE {}",
            json!({
                "variant":v.label(),"collision":collision,"phase":"ntStatus",
                "ntStatus":code,"ntStatusHex":format!("0x{:08x}",code as u32),
                "mappedWin32":mapped,"iosbStatus":unsafe { iosb.Anonymous.Status },
                "iosbInformation":iosb.Information,"iosbInitializedZero":true
            })
        );
        // Do not label a warning/nonzero status success, even if the namespace
        // later shows effects. The IOSB is diagnostic; on error its initial zero
        // is not a claim that the kernel completed a successful rename.
        return if code == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(mapped.unwrap() as i32))
        };
    }
    let rename = allocation.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*rename).RootDirectory = handle(&temporary.directory);
        (*rename).FileNameLength = name_bytes as u32;
        ptr::copy_nonoverlapping(
            destination.as_ptr(),
            (*rename).FileName.as_mut_ptr(),
            destination.len(),
        );
        if SetFileInformationByHandle(
            handle(&temporary.file),
            FileRenameInfo,
            rename.cast(),
            count as u32,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
fn observe(v: Variant, collision: bool) -> (bool, bool) {
    const PAYLOAD: &[u8] = b"owned rename primitive\n";
    const SENTINEL: &[u8] = b"keep existing target\n";
    // Each method/condition gets a fresh exclusive directory and source object.
    // This is a comparison, never a retry/fallback on one unknown publication.
    let fixture = need(phase(v, collision, "fixture", tempfile::tempdir()));
    let canonical = need(phase(
        v,
        collision,
        "canonicalize",
        fixture.path().canonicalize(),
    ));
    let parent = need(phase(v, collision, "open", open_directory(&canonical)));
    let parent_before = need(phase(v, collision, "parentStamp", stamp(&parent)));
    let sentinel_id = if collision {
        let mut file = need(phase(
            v,
            collision,
            "sentinelCreate",
            open_at(&parent, OsStr::new(v.leaf()), false, true),
        ));
        need(phase(
            v,
            collision,
            "sentinelWrite",
            file.write_all(SENTINEL),
        ));
        need(phase(v, collision, "sentinelSync", file.sync_all()));
        Some(need(phase(v, collision, "sentinelStamp", stamp(&file))).identity)
    } else {
        None
    };
    let mut temporary = need(phase(
        v,
        collision,
        "create",
        TemporaryExport::create(parent),
    ));
    need(phase(
        v,
        collision,
        "write",
        temporary.file.write_all(PAYLOAD),
    ));
    need(phase(v, collision, "sync", temporary.file.sync_all()));
    let before = need(phase(v, collision, "sourceStamp", stamp(&temporary.file)));
    if matches!(v, Variant::OriginalLeaf | Variant::ShortExact) {
        let units = v.leaf().encode_utf16().count();
        let count = offset_of!(FILE_RENAME_INFO, FileName) + units * 2;
        eprintln!(
            "FARFOLD_RENAME_PRIMITIVE {}",
            json!({
                "variant":v.label(),"collision":collision,"phase":"productionDerivedLayout",
                "nameUnits":units,"passedBytes":count,"structBytes":size_of::<FILE_RENAME_INFO>(),
                "fileNameOffset":offset_of!(FILE_RENAME_INFO,FileName),
                "rootOffset":offset_of!(FILE_RENAME_INFO,RootDirectory),
                "lengthOffset":offset_of!(FILE_RENAME_INFO,FileNameLength),
                "allocationBytes":count.div_ceil(size_of::<usize>())*size_of::<usize>(),
                "relativeRootNonNull":true,"replace":false
            })
        );
    }
    let result = match v {
        Variant::OriginalLeaf | Variant::ShortExact => temporary.publish(OsStr::new(v.leaf())),
        _ => manual(v, collision, &temporary),
    };
    // Never let TemporaryExport's Drop classify an uncertain direct primitive
    // as an unpublished object. Cleanup is only the exact owned TempDir below.
    temporary.retain_unknown();
    let result = phase(v, collision, "publication", result);
    let code = result.as_ref().err().and_then(io::Error::raw_os_error);
    let after = need(phase(
        v,
        collision,
        "sourceAfterStamp",
        stamp(&temporary.file),
    ));
    assert!(
        before.identity == after.identity,
        "source full identity changed"
    );
    let parent_after = need(phase(
        v,
        collision,
        "parentAfterStamp",
        stamp(&temporary.directory),
    ));
    assert!(
        parent_before.identity == parent_after.identity,
        "held parent full identity changed"
    );
    let reopened = phase(
        v,
        collision,
        "reopen",
        open_relative(&temporary.directory, Path::new(v.leaf())),
    );
    if collision {
        let mut file = need(reopened);
        let target = need(phase(v, collision, "targetStamp", stamp(&file)));
        assert!(
            Some(target.identity) == sentinel_id,
            "existing target full identity changed"
        );
        assert_eq!(
            need(phase(v, collision, "readback", body(&mut file))),
            SENTINEL
        );
        assert!(
            result.is_err(),
            "no-replace primitive overwrote its existing target"
        );
    } else if result.is_ok() {
        let mut file = need(reopened);
        let target = need(phase(v, collision, "targetStamp", stamp(&file)));
        assert!(
            target.identity == before.identity,
            "published target is not exact source"
        );
        assert_eq!(
            need(phase(v, collision, "readback", body(&mut file))),
            PAYLOAD
        );
    } else {
        assert!(
            matches!(reopened, Err(ref error) if error.raw_os_error()==Some(ERROR_FILE_NOT_FOUND as i32)),
            "failed call had unknown namespace effects; not an absent target baseline"
        );
    }
    let success = result.is_ok();
    let exists_error =
        matches!(code, Some(c) if c==ERROR_FILE_EXISTS as i32 || c==ERROR_ALREADY_EXISTS as i32);
    eprintln!(
        "FARFOLD_RENAME_PRIMITIVE {}",
        json!({
            "variant":v.label(),"collision":collision,"phase":"observationComplete",
            "publicationSuccess":success,"specificExistsError":exists_error,"fullSourceIdentityStable":true,
            "fullParentIdentityStable":true,"targetIdentityAndBytesChecked":collision||success
        })
    );
    drop(temporary);
    need(phase(v, collision, "ownedCleanup", fixture.close()));
    (success, exists_error)
}
#[test]
fn ci6_rename_publication_primitive_matrix_owned_once() {
    let variants = [
        Variant::OriginalLeaf,
        Variant::ShortExact,
        Variant::Win32Nul,
        Variant::Win32Struct,
        Variant::Win32Aligned,
        Variant::NtStruct,
    ];
    let mut covered = 0;
    for variant in variants {
        let (created, _) = observe(variant, false);
        let (_, exists) = observe(variant, true);
        covered += usize::from(created && exists);
    }
    // This is a diagnostic baseline, not "all methods passed" or product fix.
    // Keep the original CI5 production test and its assertions unchanged.
    assert!(
        covered > 0,
        "no selected primitive established success plus no-replace baseline"
    );
}

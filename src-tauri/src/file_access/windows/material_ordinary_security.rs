//! Explicit ordinary facets on original handles. No token or source mutation.
use super::*;
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{BLOCK, Error, Resident, Result, charge, check, io_error},
    material_ordinary_security_records::{self as records, Owned, Summary},
};
use std::sync::atomic::AtomicBool;
use windows_sys::Win32::Security::{
    ACL, ATTRIBUTE_SECURITY_INFORMATION,
    Authorization::{SE_FILE_OBJECT, SetSecurityInfo},
    DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, GetKernelObjectSecurity,
    GetSecurityDescriptorDacl, GetSecurityDescriptorGroup, GetSecurityDescriptorLength,
    GetSecurityDescriptorOwner, GetSecurityDescriptorSacl, IsValidSecurityDescriptor,
    LABEL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    SCOPE_SECURITY_INFORMATION, SE_DACL_PROTECTED, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
fn query(file: &File, fields: u32, work: &mut WorkBudget, cancel: &AtomicBool) -> Result<Vec<u64>> {
    check(cancel)?;
    charge(work, BLOCK)?;
    let mut raw = Vec::with_capacity(BLOCK / 8 + 1);
    raw.resize(BLOCK / 8, 0u64);
    let mut length = 0;
    if unsafe {
        GetKernelObjectSecurity(
            handle(file),
            fields,
            raw.as_mut_ptr().cast(),
            BLOCK as u32,
            &mut length,
        )
    } == 0
    {
        return Err(io_error(
            "ordinarySecurityQuery",
            io::Error::last_os_error(),
        ));
    }
    if !(20..=BLOCK as u32).contains(&length)
        || unsafe { IsValidSecurityDescriptor(raw.as_ptr().cast_mut().cast()) } == 0
        || unsafe { GetSecurityDescriptorLength(raw.as_ptr().cast_mut().cast()) } != length
    {
        return Err(Error::Invalid);
    }
    // The final word also carries the actual byte count; never derive it from capacity.
    raw.truncate((length as usize).div_ceil(8));
    raw.push(length as u64);
    Ok(raw)
}
fn bytes(raw: &[u64]) -> Result<&[u8]> {
    let length = *raw.last().ok_or(Error::Invalid)? as usize;
    if length < 20 || length > (raw.len() - 1) * 8 {
        return Err(Error::Invalid);
    }
    Ok(unsafe { std::slice::from_raw_parts(raw.as_ptr().cast_mut().cast(), length) })
}
fn require_empty_policy(
    file: &File,
    fields: u32,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<()> {
    let raw = query(file, fields, work, cancel)?;
    let raw = bytes(&raw)?;
    let at = u32::from_le_bytes(raw[12..16].try_into().expect("fixed")) as usize;
    if at == 0 {
        return Ok(());
    }
    if at < 20 || !at.is_multiple_of(4) || at.checked_add(8).is_none_or(|n| n > raw.len()) {
        return Err(Error::Invalid);
    }
    let size = u16::from_le_bytes(raw[at + 2..at + 4].try_into().expect("fixed")) as usize;
    let count = u16::from_le_bytes(raw[at + 4..at + 6].try_into().expect("fixed"));
    if size < 8 || at.checked_add(size).is_none_or(|n| n > raw.len()) {
        return Err(Error::Invalid);
    }
    if count != 0 {
        return Err(Error::Unsupported);
    }
    Ok(())
}
pub(super) fn capture(
    file: &File,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Owned> {
    // Two aligned queries, one temporary policy query and the output frame.
    let _scratch = resident.lease(3 * (BLOCK + 16))?;
    let dacl = query(
        file,
        OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        work,
        cancel,
    )?;
    let label = query(file, LABEL_SECURITY_INFORMATION, work, cancel)?;
    require_empty_policy(file, ATTRIBUTE_SECURITY_INFORMATION, work, cancel)?;
    require_empty_policy(file, SCOPE_SECURITY_INFORMATION, work, cancel)?;
    records::encode(bytes(&dacl)?, bytes(&label)?, work, cancel, resident)
}
pub(super) fn verify(
    file: &File,
    expected: &Summary,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    let actual = capture(file, work, cancel, resident)?;
    if !actual.summary.same_facets(expected) {
        #[cfg(test)]
        eprintln!(
            "FARFOLD_ORDINARY_DIAGNOSTIC phase=security-verify dacl_equal={} label_equal={} expected_aces={} actual_aces={} expected_labels={} actual_labels={}",
            actual.summary.dacl_sha256 == expected.dacl_sha256,
            actual.summary.label_sha256 == expected.label_sha256,
            expected.dacl_aces,
            actual.summary.dacl_aces,
            expected.labels,
            actual.summary.labels,
        );
        return Err(Error::Changed);
    }
    Ok(())
}
pub(super) fn restore(
    file: &File,
    raw: &[u8],
    expected: &Summary,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    let decoded = records::decode(raw, work, cancel)?;
    if &decoded.summary != expected {
        return Err(Error::Changed);
    }
    let initial = capture(file, work, cancel, resident)?;
    if initial.summary.same_facets(expected) {
        return Ok(());
    }
    // Copy into explicitly aligned buffers before passing the bounded SD to Win32.
    let _memory = resident.lease(raw.len() + 16)?;
    let aligned = |bytes: &[u8]| {
        let mut out = vec![0u64; bytes.len().div_ceil(8)];
        unsafe {
            ptr::copy_nonoverlapping(bytes.as_ptr(), out.as_mut_ptr().cast(), bytes.len());
        }
        out
    };
    let dacl = aligned(decoded.owner_group_dacl);
    let label = aligned(decoded.label);
    if initial.summary.dacl_sha256 != expected.dacl_sha256 {
        let mut owner = ptr::null_mut();
        let mut group = ptr::null_mut();
        let mut acl: *mut ACL = ptr::null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        if unsafe {
            GetSecurityDescriptorOwner(dacl.as_ptr().cast_mut().cast(), &mut owner, &mut defaulted)
        } == 0
            || unsafe {
                GetSecurityDescriptorGroup(
                    dacl.as_ptr().cast_mut().cast(),
                    &mut group,
                    &mut defaulted,
                )
            } == 0
            || unsafe {
                GetSecurityDescriptorDacl(
                    dacl.as_ptr().cast_mut().cast(),
                    &mut present,
                    &mut acl,
                    &mut defaulted,
                )
            } == 0
            || present == 0
            || owner.is_null()
            || group.is_null()
        {
            return Err(Error::Unsupported);
        }
        let control = u16::from_le_bytes(decoded.owner_group_dacl[2..4].try_into().expect("fixed"));
        #[cfg(test)]
        eprintln!(
            "FARFOLD_ORDINARY_DIAGNOSTIC phase=security-before-set source_control={control} initial_control={} expected_aces={} initial_aces={}",
            u16::from_le_bytes(initial.bytes[18..20].try_into().expect("encoded control")),
            expected.dacl_aces,
            initial.summary.dacl_aces,
        );
        let fields = OWNER_SECURITY_INFORMATION
            | GROUP_SECURITY_INFORMATION
            | DACL_SECURITY_INFORMATION
            | if control & SE_DACL_PROTECTED != 0 {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
        check(cancel)?;
        charge(work, raw.len())?;
        let status = unsafe {
            SetSecurityInfo(
                handle(file),
                SE_FILE_OBJECT,
                fields,
                owner,
                group,
                acl,
                ptr::null(),
            )
        };
        if status != 0 {
            return Err(Error::Io {
                phase: "ordinarySecuritySet",
                code: Some(status as i32),
            });
        }
    }
    let mut present = 0;
    let mut defaulted = 0;
    let current = capture(file, work, cancel, resident)?;
    #[cfg(test)]
    eprintln!(
        "FARFOLD_ORDINARY_DIAGNOSTIC phase=security-after-dacl-set current_control={} dacl_equal={} label_equal={} expected_aces={} current_aces={}",
        u16::from_le_bytes(current.bytes[18..20].try_into().expect("encoded control")),
        current.summary.dacl_sha256 == expected.dacl_sha256,
        current.summary.label_sha256 == expected.label_sha256,
        expected.dacl_aces,
        current.summary.dacl_aces,
    );
    if current.summary.label_sha256 != expected.label_sha256 {
        let mut sacl: *mut ACL = ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorSacl(
                label.as_ptr().cast_mut().cast(),
                &mut present,
                &mut sacl,
                &mut defaulted,
            )
        } == 0
            || present == 0
            || sacl.is_null()
        {
            return Err(Error::Unsupported);
        }
        check(cancel)?;
        charge(work, decoded.label.len())?;
        let status = unsafe {
            SetSecurityInfo(
                handle(file),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
                sacl,
            )
        };
        if status != 0 {
            return Err(Error::Io {
                phase: "ordinaryLabelSet",
                code: Some(status as i32),
            });
        }
    }
    verify(file, expected, work, cancel, resident)
}

#[cfg(test)]
#[path = "material_ordinary_security_tests.rs"]
mod tests;

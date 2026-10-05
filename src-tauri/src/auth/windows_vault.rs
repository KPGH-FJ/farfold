//! Windows Credential Manager, in the current user's logon context. No shell,
//! plaintext file, Agent config, environment variable, or registry secret store.
//! Generic blobs use UTF-8; targets are namespaced hashes of exact internal IDs
//! because Windows credential target names are case-insensitive.

use sha2::{Digest, Sha256};

const MAX_BLOB: usize = 5 * 512;
const NAMESPACE: &str = "Farfold/ai.farfold.desktop/credential/v1/";

fn target(service: &str) -> Result<Vec<u16>, String> {
    if service.is_empty() || service.len() > 8192 || service.chars().any(char::is_control) {
        return Err("密钥标识无效，原记录保持不变".into());
    }
    let hash = Sha256::digest(service.as_bytes());
    let suffix: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{NAMESPACE}{suffix}")
        .encode_utf16()
        .chain([0])
        .collect())
}

fn validate_secret(key: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.chars().any(char::is_control) {
        return Err("请输入有效的单行密钥".into());
    }
    if key.len() > MAX_BLOB {
        return Err("密钥超过 Windows 系统凭据的大小限制，原记录保持不变".into());
    }
    Ok(())
}

fn decode_blob(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_BLOB {
        return None;
    }
    let value = std::str::from_utf8(bytes).ok()?;
    validate_secret(value).ok()?;
    Some(value.to_owned())
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::{ERROR_NOT_FOUND, GetLastError},
        Security::Credentials::{
            CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
            CredReadW, CredWriteW,
        },
    };

    pub(crate) fn store(service: &str, key: &str) -> Result<(), String> {
        validate_secret(key)?;
        let mut name = target(service)?;
        let mut user: Vec<u16> = "Farfold".encode_utf16().chain([0]).collect();
        let mut blob = key.as_bytes().to_vec();
        // CREDENTIALW is an OS input struct; all reserved fields remain zero.
        let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = name.as_mut_ptr();
        credential.UserName = user.as_mut_ptr();
        credential.CredentialBlob = blob.as_mut_ptr();
        credential.CredentialBlobSize = blob.len() as u32;
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
        // SAFETY: all buffers and the C struct live until this synchronous call
        // returns; blob length fits the documented generic-credential limit.
        let saved = unsafe { CredWriteW(&credential, 0) } != 0;
        erase(&mut blob);
        if saved {
            Ok(())
        } else {
            Err("无法保存到 Windows 系统凭据，请检查访问权限后重试".into())
        }
    }

    struct ReadCredential(*mut CREDENTIALW);
    impl Drop for ReadCredential {
        fn drop(&mut self) {
            // SAFETY: CredReadW owns a single allocation, including all fields;
            // this RAII owner is created only after a successful, non-null read.
            unsafe { CredFree(self.0.cast()) };
        }
    }

    pub(crate) fn lookup(service: &str) -> Option<String> {
        let name = target(service).ok()?;
        let mut pointer = null_mut();
        // Flags are reserved and must be zero. Never enumerate other entries.
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0
            || pointer.is_null()
        {
            return None;
        }
        let owner = ReadCredential(pointer);
        let credential = unsafe { &*owner.0 };
        let size = credential.CredentialBlobSize as usize;
        if credential.Type != CRED_TYPE_GENERIC
            || size == 0
            || size > MAX_BLOB
            || credential.CredentialBlob.is_null()
        {
            return None;
        }
        // SAFETY: the live OS allocation owns exactly CredentialBlobSize bytes;
        // bounded above before constructing the slice, and freed after decoding.
        let bytes = unsafe { std::slice::from_raw_parts_mut(credential.CredentialBlob, size) };
        let result = decode_blob(bytes);
        erase(bytes);
        result
    }

    pub(crate) fn delete(service: &str) -> Result<(), String> {
        let name = target(service)?;
        // Generic target + exact Farfold namespace only. Absent is idempotent;
        // permission/session failures do not become a successful deletion.
        if unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || unsafe { GetLastError() } == ERROR_NOT_FOUND
        {
            Ok(())
        } else {
            Err("无法清除 Windows 系统凭据，请检查访问权限后重试".into())
        }
    }

    fn erase(bytes: &mut [u8]) {
        for byte in bytes {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

#[cfg(windows)]
pub(crate) use native::{delete, lookup, store};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_is_namespaced_deterministic_and_distinguishes_case_sensitive_ids() {
        let name = target("farfold.credential.Example").unwrap();
        assert_eq!(name, target("farfold.credential.Example").unwrap());
        assert_ne!(name, target("farfold.credential.example").unwrap());
        assert_eq!(name.last(), Some(&0));
        let visible = String::from_utf16(&name[..name.len() - 1]).unwrap();
        assert!(visible.starts_with(NAMESPACE));
        assert!(!visible.contains("Example"));
        for invalid in ["", "name\0other", "name\nother"] {
            assert!(target(invalid).is_err());
        }
    }

    #[test]
    fn windows_blob_limit_uses_bytes_and_preserves_valid_utf8_exactly() {
        assert!(validate_secret(&"a".repeat(MAX_BLOB)).is_ok());
        assert!(validate_secret(&"a".repeat(MAX_BLOB + 1)).is_err());
        assert!(validate_secret(&"密".repeat(MAX_BLOB / 3 + 1)).is_err());
        assert_eq!(
            decode_blob("测试 key".as_bytes()).as_deref(),
            Some("测试 key")
        );
        assert!(decode_blob(&[0xff]).is_none());
        assert!(decode_blob(b"bad\nkey").is_none());
        assert!(decode_blob(b"").is_none());
    }
}

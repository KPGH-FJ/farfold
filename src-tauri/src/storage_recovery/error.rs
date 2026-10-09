use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IssueKind {
    ReadOnly,
    Full,
    Corrupt,
    Permission,
    Missing,
    Busy,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageIssue {
    pub kind: IssueKind,
}

impl StorageIssue {
    pub fn new(kind: IssueKind) -> Self {
        Self { kind }
    }
    pub fn from_receipt(receipt: &str) -> Self {
        let kind = match receipt
            .strip_prefix("FARFOLD_STORAGE:")
            .and_then(|value| value.split(':').next())
        {
            Some("readOnly") => IssueKind::ReadOnly,
            Some("full") => IssueKind::Full,
            Some("corrupt") => IssueKind::Corrupt,
            Some("permission") => IssueKind::Permission,
            Some("missing") => IssueKind::Missing,
            Some("busy") => IssueKind::Busy,
            _ => IssueKind::Unknown,
        };
        Self::new(kind)
    }
}

pub(crate) fn sqlite_receipt(error: rusqlite::Error) -> String {
    use rusqlite::ErrorCode;
    let extended = error.sqlite_error().map(|error| error.extended_code);
    let code = match (extended, error.sqlite_error_code()) {
        (Some(rusqlite::ffi::SQLITE_READONLY_DBMOVED), _) => "missing",
        // A read-only validation cannot replay a pending rollback/WAL recovery.
        // This is not evidence that the filesystem permissions are read-only.
        (
            Some(rusqlite::ffi::SQLITE_READONLY_RECOVERY | rusqlite::ffi::SQLITE_READONLY_ROLLBACK),
            _,
        ) => "unknown",
        (_, Some(ErrorCode::ReadOnly)) => "readOnly",
        (_, Some(ErrorCode::DiskFull)) => "full",
        (_, Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)) => "corrupt",
        (_, Some(ErrorCode::PermissionDenied | ErrorCode::AuthorizationForStatementDenied)) => {
            "permission"
        }
        (_, Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)) => "busy",
        _ => "unknown",
    };
    // Keep a stable machine receipt without SQL, stored values, paths or credentials.
    format!("FARFOLD_STORAGE:{code}:无法读取或保存本机资料")
}

pub(crate) fn io_receipt(error: std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permission",
        std::io::ErrorKind::NotFound => "missing",
        std::io::ErrorKind::StorageFull => "full",
        std::io::ErrorKind::ReadOnlyFilesystem => "readOnly",
        _ => "unknown",
    };
    format!("FARFOLD_STORAGE:{code}:无法读取或保存本机资料")
}

use serde::{Deserialize, Deserializer, Serialize};

fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
macro_rules! words {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub(crate) enum $name { $($variant),+ }
    };
}
words!(Role { User, Agent, Tool });
words!(Declaration {
    MessageAttachment,
    ToolAttachment,
    ResourceLink,
    ReportedFile
});
words!(Representation {
    LocalCurrentFile,
    ReceivedText,
    ReceivedBytes,
    ReferenceOnly
});
words!(SelectedBy {
    DeclaredSource,
    FilePickerSubstitute
});
words!(Omission {
    NotSelected,
    RemoteNotFetched,
    UnsupportedSource,
    MissingPayload,
    Changed,
    Unreadable,
    TooLarge,
    InvalidData,
    ReplacedByUserSelection
});

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Origin {
    pub item_ordinal: u64,
    pub role: Role,
    #[serde(deserialize_with = "nullable")]
    pub attachment_ordinal: Option<u64>,
    #[serde(deserialize_with = "nullable")]
    pub tool_content_ordinal: Option<u64>,
    pub declaration: Declaration,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Candidate {
    pub candidate_id: String,
    pub origin: Origin,
    pub display_name: String,
    #[serde(deserialize_with = "nullable")]
    pub declared_mime_type: Option<String>,
    pub representation: Representation,
    #[serde(deserialize_with = "nullable")]
    pub replaces_candidate_id: Option<String>,
}
// Do not relax the existing VerifiedFile reader's wire while making this new input strict.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalFile {
    pub root: String,
    pub path: String,
    pub resolved_path: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub version: String,
}
impl From<&LocalFile> for crate::file_delivery::VerifiedFile {
    fn from(f: &LocalFile) -> Self {
        Self {
            root: f.root.clone(),
            path: f.path.clone(),
            resolved_path: f.resolved_path.clone(),
            name: f.name.clone(),
            size: f.size,
            sha256: f.sha256.clone(),
            version: f.version.clone(),
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Source {
    Local {
        file: LocalFile,
        #[serde(rename = "selectedBy")]
        selected_by: SelectedBy,
    },
    InlineText {
        text: String,
        #[serde(rename = "utf8Bytes")]
        utf8_bytes: u64,
    },
    InlineBinary {
        base64: String,
        #[serde(rename = "decodedBytes")]
        decoded_bytes: u64,
    },
}
impl Source {
    pub fn size(&self) -> u64 {
        match self {
            Self::Local { file, .. } => file.size,
            Self::InlineText { utf8_bytes, .. } => *utf8_bytes,
            Self::InlineBinary { decoded_bytes, .. } => *decoded_bytes,
        }
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selected {
    pub candidate_id: String,
    pub source: Source,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Omitted {
    pub candidate_id: String,
    pub reason: Omission,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepare {
    pub operation_id: String,
    pub input_sha256: String,
    pub snapshot_id: String,
    pub selection_id: String,
    pub destination: String,
    pub markdown: String,
    pub candidates: Vec<Candidate>,
    pub selected: Vec<Selected>,
    pub omitted: Vec<Omitted>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Key {
    pub operation_id: String,
    pub input_sha256: String,
}
impl Prepare {
    pub fn key(&self) -> Key {
        Key {
            operation_id: self.operation_id.clone(),
            input_sha256: self.input_sha256.clone(),
        }
    }
}
words!(State {
    Ready,
    Writing,
    Cancelling,
    Publishing,
    Completed,
    Cancelled,
    Failed,
    Unknown
});
impl State {
    pub fn working(self) -> bool {
        matches!(self, Self::Writing | Self::Cancelling | Self::Publishing)
    }
}
words!(Publication {
    NotPublished,
    Published,
    Unknown
});
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub kind: &'static str,
    pub destination: String,
    pub zip_size: u64,
    pub zip_sha256: String,
    pub manifest_sha256: String,
    pub included_count: usize,
    pub omitted_count: usize,
    pub scope: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub kind: &'static str,
    pub operation_id: String,
    pub input_sha256: String,
    pub snapshot_id: String,
    pub selection_id: String,
    pub destination: String,
    pub included_count: usize,
    pub omitted_count: usize,
    pub total_input_bytes: u64,
    pub processed_input_bytes: u64,
    pub items_completed: usize,
    pub state: State,
    pub settled: bool,
    pub publication: Publication,
    pub receipt: Option<Receipt>,
    pub code: Option<&'static str>,
    pub failed_candidate_id: Option<String>,
}
impl Status {
    pub fn ready(input: &Prepare) -> Self {
        Self {
            kind: "conversationArchive",
            operation_id: input.operation_id.clone(),
            input_sha256: input.input_sha256.clone(),
            snapshot_id: input.snapshot_id.clone(),
            selection_id: input.selection_id.clone(),
            destination: input.destination.clone(),
            included_count: input.selected.len(),
            omitted_count: input.omitted.len(),
            total_input_bytes: input.selected.iter().map(|s| s.source.size()).sum(),
            processed_input_bytes: 0,
            items_completed: 0,
            state: State::Ready,
            settled: false,
            publication: Publication::NotPublished,
            receipt: None,
            code: None,
            failed_candidate_id: None,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum Reply {
    Status(Box<Status>),
    Absent {
        kind: &'static str,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "inputSha256")]
        input_sha256: String,
        state: &'static str,
        settled: bool,
        #[serde(rename = "admissionClosed")]
        admission_closed: bool,
        result: &'static str,
        scope: &'static str,
    },
}
impl Reply {
    pub fn absent(key: &Key, closed: bool) -> Self {
        Self::Absent {
            kind: "conversationArchive",
            operation_id: key.operation_id.clone(),
            input_sha256: key.input_sha256.clone(),
            state: "absent",
            settled: true,
            admission_closed: closed,
            result: "unknown",
            scope: "currentProcess",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct Failure {
    pub code: &'static str,
}
pub(crate) fn fail(code: &'static str) -> Failure {
    Failure { code }
}

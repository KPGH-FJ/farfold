use super::types::*;
use serde_json::{Value, json};

// These extensions are filename hints only, never content/MIME verification.
// The basename always comes from the selected ordinal, not a source path.
pub(crate) fn member(index: usize, source: &Source, display_name: &str) -> String {
    let hint = display_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    let extension = if matches!(source, Source::InlineText { .. }) {
        "txt"
    } else {
        match hint.as_str() {
            "pdf" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "txt" | "md" | "csv" | "json"
            | "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp" | "mp3" | "wav" | "m4a" | "mp4"
            | "mov" | "webm" | "zip" => hint.as_str(),
            _ => "bin",
        }
    };
    format!("attachments/{:04}.{extension}", index + 1)
}
pub(crate) fn document(input: &Prepare, hashes: &[String]) -> Vec<u8> {
    let records:Vec<Value>=input.candidates.iter().map(|c| {
        let selected=input.selected.iter().enumerate().find(|(_,s)|s.candidate_id==c.candidate_id);
        let content=selected.map(|(i,s)|json!({"member":member(i,&s.source,&c.display_name),"size":s.source.size(),"sha256":hashes[i]}));
        let reason=input.omitted.iter().find(|o|o.candidate_id==c.candidate_id).map(|o|o.reason);
        json!({"candidateId":c.candidate_id,"origin":c.origin,"displayName":c.display_name,
            "declaredMimeType":c.declared_mime_type,"mimeValidation":"declarationOnly","formatValidation":"notChecked",
            "representation":c.representation,"replacesCandidateId":c.replaces_candidate_id,
            "included":content,"omitted":reason})
    }).collect();
    serde_json::to_vec(&json!({"format":"farfoldReadableArchive","version":1,
        "scope":"selectedLoadedSnapshot","resumableAgentSession":false,
        "transcript":{"member":"conversation.md","size":input.markdown.len(),"sha256":super::input::hash(input.markdown.as_bytes())},
        "includedCount":input.selected.len(),"omittedCount":input.omitted.len(),"items":records})).expect("typed manifest")
}
pub(crate) fn estimated_size(input: &Prepare) -> usize {
    document(input, &vec!["0".repeat(64); input.selected.len()]).len()
}

use crate::meta_store::MetaStore;
use crate::meta_store::prompt_templates::TemplateWriteReceipt;
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn prompt_templates_save(
    app: AppHandle,
    expected: Value,
    next: Value,
) -> Result<TemplateWriteReceipt, String> {
    let store = app
        .try_state::<MetaStore>()
        .ok_or("设置暂不可用，请稍后重试")?
        .inner()
        .clone();
    store
        .run(move |store| store.save_prompt_templates(&expected, &next))
        .await
}

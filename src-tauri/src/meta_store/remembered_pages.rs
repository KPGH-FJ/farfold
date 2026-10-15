//! Explicit public-page locations only; this is not browser history or authority.
use super::*;

pub(crate) const MAX_ITEMS: usize = 100;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const INVALID: &str = "已记住的网页格式无法识别，原记录已保留";
const CHANGED: &str = "已记住的网页清单已变化，请查看后重试";
const OWNER_CHANGED: &str = "对话已变化或尚未保存，请返回当前对话后重试";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageOwner {
    pub session_id: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RememberedPage {
    pub id: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct RememberedPages {
    pub owner: PageOwner,
    pub revision: u64,
    pub items: Vec<RememberedPage>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedPages {
    version: u8,
    created_at: i64,
    revision: u64,
    items: Vec<RememberedPage>,
}

pub(super) fn key(session_id: &str) -> String {
    format!("browserPages.v1:{session_id}")
}

fn validate_owner(connection: &Connection, owner: &PageOwner) -> Result<(), String> {
    if owner.session_id.is_empty()
        || owner.session_id.encode_utf16().count() > 1024
        || owner.session_id.chars().any(char::is_control)
        || !(0..=MAX_REVISION as i64).contains(&owner.created_at)
    {
        return Err(OWNER_CHANGED.into());
    }
    let created: Option<i64> = connection
        .query_row(
            "SELECT created_at FROM sessions WHERE id=?1",
            [&owner.session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_receipt)?;
    if created != Some(owner.created_at) {
        return Err(OWNER_CHANGED.into());
    }
    Ok(())
}

fn valid_item(item: &RememberedPage) -> bool {
    item.id.len() == 32
        && item.id.bytes().all(|byte| byte.is_ascii_hexdigit())
        && crate::browser_workspace::validate_public_url(&item.url)
            .is_ok_and(|url| url.as_str() == item.url)
}

fn read(connection: &Connection, owner: &PageOwner) -> Result<RememberedPages, String> {
    validate_owner(connection, owner)?;
    let raw: Option<Option<String>> = connection
        .query_row(
            "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ?2 THEN value END FROM settings WHERE key=?1",
            params![key(&owner.session_id), MAX_BYTES as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_receipt)?;
    let Some(raw) = raw else {
        return Ok(RememberedPages {
            owner: owner.clone(),
            revision: 0,
            items: Vec::new(),
        });
    };
    let raw = raw.ok_or(INVALID)?;
    let saved: SavedPages = serde_json::from_str(&raw).map_err(|_| INVALID)?;
    let mut ids = std::collections::HashSet::new();
    let mut urls = std::collections::HashSet::new();
    if saved.version != 1
        || saved.created_at != owner.created_at
        || saved.revision == 0
        || saved.revision > MAX_REVISION
        || saved.items.len() > MAX_ITEMS
        || saved
            .items
            .iter()
            .any(|item| !valid_item(item) || !ids.insert(&item.id) || !urls.insert(&item.url))
    {
        return Err(INVALID.into());
    }
    Ok(RememberedPages {
        owner: owner.clone(),
        revision: saved.revision,
        items: saved.items,
    })
}

fn check_revision(pages: &RememberedPages, expected: u64) -> Result<(), String> {
    if pages.revision != expected {
        return Err(CHANGED.into());
    }
    Ok(())
}

fn write(
    transaction: &rusqlite::Transaction<'_>,
    mut pages: RememberedPages,
) -> Result<RememberedPages, String> {
    pages.revision = pages
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= MAX_REVISION)
        .ok_or("网页清单无法继续保存，请先导出所需网址")?;
    let raw = serde_json::to_string(&SavedPages {
        version: 1,
        created_at: pages.owner.created_at,
        revision: pages.revision,
        items: pages.items.clone(),
    })
    .map_err(|_| INVALID)?;
    if raw.len() > MAX_BYTES {
        return Err("已记住的网页过多，请先忘记不需要的网址".into());
    }
    transaction
        .execute(
            "INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key(&pages.owner.session_id), raw],
        )
        .map_err(sqlite_receipt)?;
    Ok(pages)
}

impl MetaStore {
    pub(crate) fn remembered_pages(&self, owner: &PageOwner) -> Result<RememberedPages, String> {
        read(&*self.lock()?, owner)
    }

    pub(crate) fn verify_page_owner(&self, owner: &PageOwner) -> Result<(), String> {
        validate_owner(&*self.lock()?, owner)
    }

    /// Caller holds the exact live page stable while this short transaction runs.
    pub(crate) fn remember_page(
        &self,
        owner: &PageOwner,
        expected: u64,
        url: &str,
    ) -> Result<RememberedPages, String> {
        let admitted = crate::browser_workspace::validate_public_url(url)?;
        if admitted.as_str() != url {
            return Err("网页地址已变化，请重新核对完整网址".into());
        }
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        let mut pages = read(&transaction, owner)?;
        check_revision(&pages, expected)?;
        if pages.items.iter().any(|item| item.url == url) {
            return Ok(pages);
        }
        if pages.items.len() >= MAX_ITEMS {
            return Err("此对话最多记住 100 个网页，请先忘记不需要的网址".into());
        }
        let id = transaction
            .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))
            .map_err(sqlite_receipt)?;
        pages.items.push(RememberedPage {
            id,
            url: url.into(),
        });
        let result = write(&transaction, pages)?;
        transaction.commit().map_err(sqlite_receipt)?;
        Ok(result)
    }

    /// Forgetting never touches a live page. Even an empty clear advances CAS.
    pub(crate) fn forget_page(
        &self,
        owner: &PageOwner,
        expected: u64,
        item_id: Option<&str>,
    ) -> Result<RememberedPages, String> {
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_receipt)?;
        let mut pages = read(&transaction, owner)?;
        check_revision(&pages, expected)?;
        if let Some(item_id) = item_id {
            if !pages.items.iter().any(|item| item.id == item_id) {
                return Err(CHANGED.into());
            }
            pages.items.retain(|item| item.id != item_id);
        } else {
            pages.items.clear();
        }
        let result = write(&transaction, pages)?;
        transaction.commit().map_err(sqlite_receipt)?;
        Ok(result)
    }

    pub(crate) fn remembered_page_url(
        &self,
        owner: &PageOwner,
        expected: u64,
        item_id: &str,
    ) -> Result<String, String> {
        let pages = self.remembered_pages(owner)?;
        check_revision(&pages, expected)?;
        pages
            .items
            .into_iter()
            .find(|item| item.id == item_id)
            .map(|item| item.url)
            .ok_or_else(|| CHANGED.into())
    }
}

#[cfg(test)]
#[path = "remembered_pages_tests.rs"]
mod tests;

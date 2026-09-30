//! Select one explicit official npm release; no floating install spec or identity pin.
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::install_job::Job;

const REGISTRY: &str = "https://registry.npmjs.org";
const MIN_AGE: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgramRelease {
    pub package: String,
    pub version: String,
    pub published_at: String,
    pub source_url: String,
    pub node_engine: String,
    pub bin: String,
}

pub(crate) fn select(
    package: &str,
    bin: &str,
    range: &str,
    job: &Job,
) -> Result<ProgramRelease, String> {
    let url = format!("{REGISTRY}/{}", package.replace('/', "%2f"));
    let bytes = job.download_bounded(
        &url,
        Duration::from_secs(30),
        8 * 1024 * 1024,
        Some(REGISTRY),
    )?;
    let metadata: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "无法读取官方程序发行信息")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "无法核对发行日期，请检查系统时间")?
        .as_secs();
    select_from(&metadata, package, bin, range, &url, now)
}

fn select_from(
    metadata: &serde_json::Value,
    package: &str,
    bin: &str,
    range: &str,
    url: &str,
    now: u64,
) -> Result<ProgramRelease, String> {
    let required =
        semver::VersionReq::parse(range).map_err(|_| "官方程序要求暂时无法识别，请查看说明")?;
    let versions = metadata["versions"]
        .as_object()
        .ok_or("官方程序发行信息不完整")?;
    let mut choices = Vec::new();
    for (version_text, manifest) in versions {
        let Ok(version) = semver::Version::parse(version_text) else {
            continue;
        };
        if !version.pre.is_empty()
            || !required.matches(&version)
            || manifest.get("deprecated").is_some()
            || manifest["name"].as_str() != Some(package)
        {
            continue;
        }
        let Some(published) = metadata["time"][version_text].as_str() else {
            continue;
        };
        let Some(epoch) = utc_seconds(published) else {
            continue;
        };
        if now.checked_sub(epoch).is_none_or(|age| age < MIN_AGE) {
            continue;
        }
        let Some(engine) = manifest["engines"]["node"].as_str() else {
            continue;
        };
        if semver::VersionReq::parse(engine).is_err() {
            continue;
        }
        let entry = match &manifest["bin"] {
            serde_json::Value::String(entry) => Some(entry.as_str()),
            serde_json::Value::Object(bins) => bins.get(bin).and_then(serde_json::Value::as_str),
            _ => None,
        };
        if entry.is_none_or(|entry| {
            entry.is_empty()
                || std::path::Path::new(entry).is_absolute()
                || std::path::Path::new(entry).components().any(|component| {
                    !matches!(
                        component,
                        std::path::Component::Normal(_) | std::path::Component::CurDir
                    )
                })
        }) {
            continue;
        }
        choices.push((
            version,
            ProgramRelease {
                package: package.into(),
                version: version_text.clone(),
                published_at: published.into(),
                source_url: url.into(),
                node_engine: engine.into(),
                bin: bin.into(),
            },
        ));
    }
    choices
        .into_iter()
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, release)| release)
        .ok_or(
            "尚未找到满足已核实要求且发布满 7 天的官方程序，请查看官方说明；原选择保持不变".into(),
        )
}

// Official npm timestamps are UTC ISO 8601. Reject unsupported/invalid forms;
// no timezone inference, permissive date rollover or new date-library dependency.
fn utc_seconds(text: &str) -> Option<u64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let date = date
        .split('-')
        .map(str::parse::<i64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if date.len() != 3 {
        return None;
    }
    let (year, month, day) = (date[0], date[1], date[2]);
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > days[(month - 1) as usize] {
        return None;
    }
    let (clock, fraction) = time
        .split_once('.')
        .map_or((time, None), |(clock, fraction)| (clock, Some(fraction)));
    if fraction.is_some_and(|fraction| {
        fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return None;
    }
    let clock = clock
        .split(':')
        .map(str::parse::<i64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if clock.len() != 3
        || !(0..24).contains(&clock[0])
        || !(0..60).contains(&clock[1])
        || !(0..60).contains(&clock[2])
    {
        return None;
    }
    // Gregorian civil date -> days since 1970-01-01 (400-year eras).
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let year_of_era = y - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let days = era * 146097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year
        - 719468;
    // Round publication fractions up, keeping the seven-day rule conservative
    // against the current clock rounded down to a whole second.
    let fractional_second =
        i64::from(fraction.is_some_and(|fraction| fraction.bytes().any(|byte| byte != b'0')));
    u64::try_from(days * 86400 + clock[0] * 3600 + clock[1] * 60 + clock[2] + fractional_second)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_release_uses_official_age_support_and_engine_metadata() {
        let old = "2026-07-21T13:33:50.381Z";
        let now = utc_seconds("2026-09-30T10:30:00Z").unwrap();
        let metadata = serde_json::json!({"versions":{
            "0.80.5":{"name":"official-pkg","engines":{"node":">=22.19.0"},"bin":{"program":"cli.js"}},
            "0.81.0":{"name":"official-pkg","engines":{"node":">=22.19.0"},"bin":{"program":"cli.js"}},
            "0.99.0":{"name":"official-pkg","engines":{"node":">=22.19.0"},"bin":{"program":"cli.js"}},
            "0.98.0":{"name":"official-pkg","engines":{"node":"unsupported || range"},"bin":{"program":"cli.js"}},
            "0.90.0-beta":{"name":"official-pkg","engines":{"node":">=22.19.0"},"bin":{"program":"cli.js"}}
        },"time":{"0.80.5":old,"0.81.0":old,"0.99.0":"2026-09-29T00:00:00Z","0.98.0":old,"0.90.0-beta":old}});
        let selected = select_from(
            &metadata,
            "official-pkg",
            "program",
            ">=0.81.0",
            "https://registry.npmjs.org/official-pkg",
            now,
        )
        .unwrap();
        assert_eq!(selected.version, "0.81.0");
        assert_eq!(selected.node_engine, ">=22.19.0");
        assert!(
            select_from(
                &metadata,
                "official-pkg",
                "program",
                ">=1.0.0",
                "official",
                now
            )
            .is_err()
        );
    }
    #[test]
    fn official_utc_timestamp_rejects_invalid_future_and_rollover_forms() {
        assert_eq!(utc_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(utc_seconds("1970-01-08T00:00:00.001Z"), Some(MIN_AGE + 1));
        assert!(utc_seconds("2026-02-29T00:00:00Z").is_none());
        assert!(utc_seconds("2024-02-29T23:59:59Z").is_some());
        assert!(utc_seconds("2026-09-30T24:00:00Z").is_none());
        assert!(utc_seconds("2026-09-30T00:00:00+08:00").is_none());
    }
}

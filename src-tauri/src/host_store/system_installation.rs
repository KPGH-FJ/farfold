//! Durable user-selected launch references. Reading a saved record never starts
//! a program and never means that its current files have been verified.
use super::{
    HostDatabase, HostStore,
    records::{self, RuntimeRegistration},
};
use crate::{
    codex_installation::CodexInstallationInspection,
    host_ids::{InstallationId, RuntimeBuildId, RuntimeProductId},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInstallation {
    pub installation_id: InstallationId,
    pub runtime_build_id: RuntimeBuildId,
    pub inspection: CodexInstallationInspection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSystemInstallation {
    pub installation_id: InstallationId,
    pub runtime_build_id: RuntimeBuildId,
    pub runtime_product_id: RuntimeProductId,
    pub selected_path: std::path::PathBuf,
    pub launch_json: String,
    pub observed_version: String,
    pub artifact_sha256: String,
    pub verified_at: i64,
}

pub(super) fn read_installations(
    connection: &rusqlite::Connection,
) -> Result<Vec<SystemInstallation>, String> {
    let mut statement = connection.prepare(
            "SELECT l.installation_id, l.runtime_build_id, l.selected_path, l.launch_json, l.verified_at,
                    b.observed_version, b.artifact_sha256, i.distribution, i.runtime_product_id
             FROM system_installation_launches l
             JOIN runtime_builds b ON b.runtime_build_id = l.runtime_build_id AND b.installation_id = l.installation_id
             JOIN runtime_installations i ON i.installation_id = l.installation_id
             WHERE i.runtime_product_id = 'codex'
             ORDER BY l.installation_id"
        ).map_err(|e| format!("无法读取系统安装记录：{e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|e| format!("无法读取系统安装记录：{e}"))?;
    rows.map(|row| {
        let (installation, build, path, json, verified_at, version, sha, distribution, product) =
            row.map_err(|e| e.to_string())?;
        let inspection: CodexInstallationInspection = serde_json::from_str(&json)
            .map_err(|_| "已保存的 Codex 程序记录无效；不能启动".to_string())?;
        if json.len() > 65536
            || path != inspection.selected_path.to_string_lossy()
            || verified_at != inspection.verified_at
            || version != inspection.version
            || sha != inspection.native_sha()
            || distribution != "system"
            || product != "codex"
        {
            return Err("系统安装记录与持久构建身份不一致；不能启动".to_string());
        }
        inspection.validate_record()?;
        Ok(SystemInstallation {
            installation_id: InstallationId::parse(installation).map_err(|e| e.to_string())?,
            runtime_build_id: RuntimeBuildId::parse(build).map_err(|e| e.to_string())?,
            inspection,
        })
    })
    .collect()
}

pub(super) fn read_runtime_system_installations(
    connection: &rusqlite::Connection,
    runtime_product_id: &RuntimeProductId,
) -> Result<Vec<RuntimeSystemInstallation>, String> {
    let mut statement = connection.prepare(
            "SELECT l.installation_id, l.runtime_build_id, l.selected_path, l.launch_json, l.verified_at,
                    b.observed_version, b.artifact_sha256, i.distribution, i.runtime_product_id
             FROM system_installation_launches l
             JOIN runtime_builds b ON b.runtime_build_id = l.runtime_build_id AND b.installation_id = l.installation_id
             JOIN runtime_installations i ON i.installation_id = l.installation_id
             WHERE i.runtime_product_id = ?1
             ORDER BY l.installation_id"
        ).map_err(|e| format!("无法读取系统安装记录：{e}"))?;
    let rows = statement
        .query_map([runtime_product_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|e| format!("无法读取系统安装记录：{e}"))?;
    rows.map(|row| {
        let (installation, build, path, json, verified_at, version, sha, distribution, product) =
            row.map_err(|e| e.to_string())?;
        if distribution != "system" || product != runtime_product_id.as_str() {
            return Err("系统安装记录与持久构建身份不一致；不能启动".to_string());
        }
        if json.len() > 65536 || serde_json::from_str::<serde_json::Value>(&json).is_err() {
            return Err("已保存的系统安装记录无效；不能启动".to_string());
        }
        Ok(RuntimeSystemInstallation {
            installation_id: InstallationId::parse(installation).map_err(|e| e.to_string())?,
            runtime_build_id: RuntimeBuildId::parse(build).map_err(|e| e.to_string())?,
            runtime_product_id: runtime_product_id.clone(),
            selected_path: std::path::PathBuf::from(path),
            launch_json: json,
            observed_version: version,
            artifact_sha256: sha,
            verified_at,
        })
    })
    .collect()
}

impl HostDatabase {
    pub(crate) fn system_installations(&self) -> Result<Vec<SystemInstallation>, String> {
        read_installations(&self.connection)
    }

    pub(crate) fn runtime_system_installations(
        &self,
        runtime_product_id: &RuntimeProductId,
    ) -> Result<Vec<RuntimeSystemInstallation>, String> {
        read_runtime_system_installations(&self.connection, runtime_product_id)
    }

    pub(crate) fn accept_runtime_system_installation(
        &mut self,
        registration: &RuntimeRegistration,
        selected_path: &std::path::Path,
        launch_json: &str,
        verified_at: i64,
    ) -> Result<RuntimeSystemInstallation, String> {
        records::validate_runtime_registration(registration)?;
        if registration.distribution != records::RuntimeDistribution::System
            || registration.connection_kind != records::RuntimeConnectionKind::SystemLocal
        {
            return Err("系统安装登记必须使用 system / system_local 身份".to_string());
        }
        if !selected_path.is_absolute()
            || selected_path.to_string_lossy().len() > 4096
            || selected_path
                .to_string_lossy()
                .chars()
                .any(char::is_control)
        {
            return Err("系统安装路径无效".to_string());
        }
        if launch_json.len() > 65536
            || serde_json::from_str::<serde_json::Value>(launch_json).is_err()
        {
            return Err("系统安装启动记录无效".to_string());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        records::register_runtime(&transaction, registration)?;
        transaction.execute(
            "INSERT INTO system_installation_launches(installation_id, runtime_build_id, selected_path, launch_json, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(installation_id) DO UPDATE SET launch_json = excluded.launch_json, verified_at = excluded.verified_at",
            params![
                registration.installation_id.as_str(),
                registration.runtime_build_id.as_str(),
                selected_path.to_string_lossy(),
                launch_json,
                verified_at
            ],
        ).map_err(|e| format!("无法登记系统安装（路径可能已属于另一安装）：{e}"))?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(RuntimeSystemInstallation {
            installation_id: registration.installation_id.clone(),
            runtime_build_id: registration.runtime_build_id.clone(),
            runtime_product_id: registration.runtime_product_id.clone(),
            selected_path: selected_path.to_path_buf(),
            launch_json: launch_json.to_string(),
            observed_version: registration.observed_version.clone(),
            artifact_sha256: registration.artifact_sha256.clone(),
            verified_at,
        })
    }

    pub(crate) fn accept_system_installation(
        &mut self,
        registration: &RuntimeRegistration,
        inspection: &CodexInstallationInspection,
    ) -> Result<SystemInstallation, String> {
        records::validate_runtime_registration(registration)?;
        inspection.validate_record()?;
        if registration.runtime_product_id.as_str() != "codex"
            || registration.distribution != records::RuntimeDistribution::System
            || registration.connection_kind != records::RuntimeConnectionKind::SystemLocal
            || registration.artifact_sha256 != inspection.native_sha()
            || registration.observed_version != inspection.version
        {
            return Err("系统安装登记与已核验程序不一致".to_string());
        }
        let json = serde_json::to_string(inspection).map_err(|e| e.to_string())?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        records::register_runtime(&transaction, registration)?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT launch_json FROM system_installation_launches WHERE installation_id = ?1",
                [registration.installation_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(existing) = existing {
            let previous: CodexInstallationInspection =
                serde_json::from_str(&existing).map_err(|_| "已保存的程序记录无效".to_string())?;
            if !previous.same_location(inspection) {
                return Err("该安装已登记；位置变化必须使用重新定位操作".to_string());
            }
        }
        transaction.execute(
            "INSERT INTO system_installation_launches(installation_id, runtime_build_id, selected_path, launch_json, verified_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(installation_id) DO UPDATE SET launch_json = excluded.launch_json, verified_at = excluded.verified_at",
            params![registration.installation_id.as_str(), registration.runtime_build_id.as_str(), inspection.selected_path.to_string_lossy(), json, inspection.verified_at],
        ).map_err(|e| format!("无法登记程序（路径可能已属于另一安装）：{e}"))?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(SystemInstallation {
            installation_id: registration.installation_id.clone(),
            runtime_build_id: registration.runtime_build_id.clone(),
            inspection: inspection.clone(),
        })
    }

    pub(crate) fn relocate_system_installation(
        &mut self,
        expected: &SystemInstallation,
        inspection: &CodexInstallationInspection,
    ) -> Result<SystemInstallation, String> {
        inspection.validate_record()?;
        if !expected.inspection.same_build(inspection) {
            return Err("新位置的程序、解释器或附属文件摘要不同；不能改绑原安装".to_string());
        }
        let previous = serde_json::to_string(&expected.inspection).map_err(|e| e.to_string())?;
        let next = serde_json::to_string(inspection).map_err(|e| e.to_string())?;
        // Compare-and-swap excludes a stale dialog or concurrent relocation.
        let count = self.connection.execute(
            "UPDATE system_installation_launches SET selected_path = ?1, launch_json = ?2, verified_at = ?3
             WHERE installation_id = ?4 AND runtime_build_id = ?5 AND launch_json = ?6",
            params![inspection.selected_path.to_string_lossy(), next, inspection.verified_at,
                    expected.installation_id.as_str(), expected.runtime_build_id.as_str(), previous],
        ).map_err(|e| format!("无法重新定位程序：{e}"))?;
        if count != 1 {
            return Err("安装记录已变化，请重新读取后操作".to_string());
        }
        Ok(SystemInstallation {
            inspection: inspection.clone(),
            ..expected.clone()
        })
    }
}

impl HostStore {
    pub(crate) fn system_installations(&self) -> Result<Vec<SystemInstallation>, String> {
        self.with_ready_database(|database| database.system_installations())
    }
    pub(crate) fn runtime_system_installations(
        &self,
        runtime_product_id: &RuntimeProductId,
    ) -> Result<Vec<RuntimeSystemInstallation>, String> {
        self.with_ready_database(|database| {
            database.runtime_system_installations(runtime_product_id)
        })
    }
    pub(crate) fn accept_runtime_system_installation(
        &self,
        registration: &RuntimeRegistration,
        selected_path: &std::path::Path,
        launch_json: &str,
        verified_at: i64,
    ) -> Result<RuntimeSystemInstallation, String> {
        self.with_ready_database(|database| {
            database.accept_runtime_system_installation(
                registration,
                selected_path,
                launch_json,
                verified_at,
            )
        })
    }
    pub(crate) fn accept_system_installation(
        &self,
        registration: &RuntimeRegistration,
        inspection: &CodexInstallationInspection,
    ) -> Result<SystemInstallation, String> {
        self.with_ready_database(|database| {
            database.accept_system_installation(registration, inspection)
        })
    }
    pub(crate) fn relocate_system_installation(
        &self,
        expected: &SystemInstallation,
        inspection: &CodexInstallationInspection,
    ) -> Result<SystemInstallation, String> {
        self.with_ready_database(|database| {
            database.relocate_system_installation(expected, inspection)
        })
    }
}

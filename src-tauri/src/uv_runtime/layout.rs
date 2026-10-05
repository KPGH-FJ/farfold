use std::path::{Path, PathBuf};

pub(super) fn venv_python(root: &Path, windows: bool) -> PathBuf {
    root.join(if windows {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })
}
pub(super) fn console_program(root: &Path, name: &str, windows: bool) -> PathBuf {
    if windows {
        root.join("Scripts").join(format!("{name}.exe"))
    } else {
        root.join("bin").join(name)
    }
}
pub(super) fn site_packages(
    root: &Path,
    windows: bool,
    check: impl Fn() -> Result<(), String>,
) -> Result<Vec<PathBuf>, String> {
    check()?;
    if windows {
        return Ok(vec![root.join("Lib/site-packages")]);
    }
    let libraries = std::fs::read_dir(root.join("lib")).map_err(|_| "安装后的程序目录不完整")?;
    let mut paths = Vec::new();
    for library in libraries {
        check()?;
        let library = library.map_err(|_| "无法读取安装后的程序目录")?;
        if library.file_name().to_string_lossy().starts_with("python") {
            paths.push(library.path().join("site-packages"));
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::uv_runtime::{UvxPackage, console_script_for};

    fn lease(id: &str) -> crate::install_job::Lease {
        crate::install_job::begin(id, tauri::ipc::Channel::new(|_| Ok(()))).unwrap()
    }
    fn fixture(root: &Path) -> (PathBuf, PathBuf) {
        let info = root.join("Lib/site-packages/example_agent-0.1.44.dist-info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(
            info.join("METADATA"),
            "Name: example-agent\nVersion: 0.1.44\n\n",
        )
        .unwrap();
        std::fs::write(
            info.join("entry_points.txt"),
            "[console_scripts]\nexample-agent = package.cli:run\n",
        )
        .unwrap();
        let command = console_program(root, "example-agent", true);
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        // A non-executed file proves metadata/layout selection, not a PE launch.
        std::fs::write(&command, b"synthetic console program").unwrap();
        (info, command)
    }
    #[test]
    fn windows_console_selection_uses_the_declared_metadata_and_exe() {
        let data = tempfile::tempdir().unwrap();
        let (info, command) = fixture(data.path());
        let package = UvxPackage::parse("example-agent==0.1.44").unwrap();
        let job = lease("uv-windows-layout-declaration");
        assert_eq!(
            console_script_for(data.path(), &package, &job.job, true).unwrap(),
            command.canonicalize().unwrap()
        );
        std::fs::write(
            info.join("entry_points.txt"),
            "[console_scripts]\nother = package.cli:run\n",
        )
        .unwrap();
        assert!(console_script_for(data.path(), &package, &job.job, true).is_err());
        assert!(command.is_file());
    }
    #[test]
    fn windows_metadata_version_and_cancel_are_checked_before_selection() {
        let data = tempfile::tempdir().unwrap();
        let (info, command) = fixture(data.path());
        let package = UvxPackage::parse("example-agent==0.1.44").unwrap();
        let job = lease("uv-windows-layout-version");
        std::fs::write(
            info.join("METADATA"),
            "Name: example-agent\nVersion: 0.1.43\n\n",
        )
        .unwrap();
        assert!(console_script_for(data.path(), &package, &job.job, true).is_err());
        let cancel = lease("uv-windows-layout-cancel");
        crate::install_job::agent_install_cancel("uv-windows-layout-cancel".into()).unwrap();
        assert!(console_script_for(data.path(), &package, &cancel.job, true).is_err());
        assert_eq!(
            std::fs::read(command).unwrap(),
            b"synthetic console program"
        );
    }
    #[test]
    fn venv_python_is_platform_specific_without_changing_the_package() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(
            venv_python(data.path(), true),
            data.path().join("Scripts/python.exe")
        );
        assert_eq!(
            venv_python(data.path(), false),
            data.path().join("bin/python")
        );
    }
}

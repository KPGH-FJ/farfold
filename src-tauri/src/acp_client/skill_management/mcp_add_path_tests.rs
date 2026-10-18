//! Windows spelling validation only: no executable is probed or launched.
use super::*;

fn input(path: &str) -> StdioInput {
    StdioInput {
        name: "local-program".into(),
        executable_path: path.into(),
        args: vec!["".into(), "space value".into(), "& literal".into()],
    }
}
#[test]
fn local_disk_program_names_are_preserved_without_execution() {
    for path in [
        r"C:\Programs\工具\program.exe",
        "D:/Program Files/local/program.exe",
        r"C:\Programs/local\program.exe",
        r"\\?\C:\Programs\program.exe",
    ] {
        let value = input(path);
        assert!(value.validate().is_ok());
        assert_eq!(value.executable_path, path);
        assert_eq!(value.args, ["", "space value", "& literal"]);
    }
}
#[test]
fn unsupported_namespaces_relative_paths_and_ambiguous_parts_are_refused() {
    for path in [
        r"\\server\share\program.exe",
        r"\\?\UNC\server\share\program.exe",
        r"\\.\pipe\program",
        r"C:program.exe",
        r"\Programs\program.exe",
        r"C:\Programs\\program.exe",
        r"C:\Programs\.\program.exe",
        r"C:\Programs\..\program.exe",
        "C:/Programs/",
        r"C:\Programs\program.exe:stream",
        r"C:\Programs\NUL.exe",
        r"C:\Programs\COM¹.exe",
        r"C:\Programs\program.exe.",
        r"C:\Programs\program.exe ",
        r"C:\Programs\bad?name.exe",
        r"\\?\C:\Programs/program.exe",
    ] {
        assert_eq!(
            input(path).validate().unwrap_err().code,
            Code::InvalidExecutablePath
        );
    }
}

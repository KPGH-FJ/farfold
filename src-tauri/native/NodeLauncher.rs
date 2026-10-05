//! Farfold-owned installation executable; no Agent logic or configuration IO.
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetConsoleCP() -> u32;
}

const MAGIC: &[u8; 8] = b"FFNODE01";
const MAX_PATH_BYTES: usize = 32 * 1024;

fn selected_paths(executable: &Path) -> std::io::Result<(PathBuf, PathBuf)> {
    let invalid = || std::io::Error::other("invalid launcher");
    let mut file = std::fs::File::open(executable)?;
    let length = file.metadata()?.len();
    if length < 16 {
        return Err(invalid());
    }
    file.seek(SeekFrom::End(-16))?;
    let mut footer = [0; 16];
    file.read_exact(&mut footer)?;
    if &footer[8..] != MAGIC {
        return Err(invalid());
    }
    let node_len = u32::from_le_bytes(footer[..4].try_into().unwrap()) as usize;
    let entry_len = u32::from_le_bytes(footer[4..8].try_into().unwrap()) as usize;
    if !(1..=MAX_PATH_BYTES).contains(&node_len)
        || !(1..=MAX_PATH_BYTES).contains(&entry_len)
        || (node_len + entry_len + 16) as u64 >= length
    {
        return Err(invalid());
    }
    file.seek(SeekFrom::End(-((node_len + entry_len + 16) as i64)))?;
    let mut paths = vec![0; node_len + entry_len];
    file.read_exact(&mut paths)?;
    let parse = |bytes: &[u8]| -> std::io::Result<PathBuf> {
        let value = std::str::from_utf8(bytes).map_err(|_| invalid())?;
        let path = PathBuf::from(value);
        if value.contains(['\0', '\r', '\n']) || !path.is_absolute() {
            return Err(invalid());
        }
        Ok(path)
    };
    Ok((parse(&paths[..node_len])?, parse(&paths[node_len..])?))
}
fn main() {
    let result = (|| {
        let (node, entry) = selected_paths(&std::env::current_exe()?)?;
        let mut command = Command::new(node);
        // An attached ConPTY/console is inherited. A background invocation must
        // not allocate a new console while forwarding its existing stdio pipes.
        if unsafe { GetConsoleCP() } == 0 {
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let status = command
            .arg(entry)
            .args(std::env::args_os().skip(1))
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()?;
        Ok::<_, std::io::Error>(status.code().unwrap_or(1))
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(_) => {
            eprintln!("无法启动所选程序");
            std::process::exit(126);
        }
    }
}

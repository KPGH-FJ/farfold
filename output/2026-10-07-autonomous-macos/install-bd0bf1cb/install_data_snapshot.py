import hashlib, json, os, stat, sys
from pathlib import Path

ROOTS = {
    "appData": "/Users/tw/Library/Application Support/ai.farfold.desktop",
    "webkit": "/Users/tw/Library/WebKit/ai.farfold.desktop",
    "cache": "/Users/tw/Library/Caches/ai.farfold.desktop",
}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def signature(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

def open_directory(path):
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd

def emit(root, relative, s, kind, extra=None):
    record = {"root": root, "path": relative, "kind": kind,
              "type": stat.S_IFMT(s.st_mode), "mode": stat.S_IMODE(s.st_mode)}
    record.update(extra or {})
    line = (json.dumps(record, ensure_ascii=True, sort_keys=True) + "\n").encode()
    writer.write(line)
    digest.update(line)
    counts[root][kind] += 1

def inspect(parent, name, root, relative):
    s = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISLNK(s.st_mode):
        extra = {"target": os.readlink(name, dir_fd=parent)}
        if signature(s) != signature(os.stat(name, dir_fd=parent, follow_symlinks=False)):
            raise RuntimeError("entry changed")
        emit(root, relative, s, "symlink", extra)
    elif stat.S_ISDIR(s.st_mode):
        fd = os.open(name, DIR_FLAGS, dir_fd=parent)
        try:
            if signature(s) != signature(os.fstat(fd)): raise RuntimeError("entry changed")
            emit(root, relative, s, "directory")
            for child in sorted(os.listdir(fd)):
                inspect(fd, child, root, relative + "/" + child)
            if signature(s) != signature(os.fstat(fd)): raise RuntimeError("directory changed")
        finally: os.close(fd)
    elif stat.S_ISREG(s.st_mode):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as stream:
            if signature(s) != signature(os.fstat(stream.fileno())): raise RuntimeError("entry changed")
            content = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""): content.update(chunk)
            if signature(s) != signature(os.fstat(stream.fileno())): raise RuntimeError("file changed")
        emit(root, relative, s, "file", {"size": s.st_size, "sha256": content.hexdigest()})
    else:
        emit(root, relative, s, "special")

if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("before", "after") or sys.argv[2] != "--normal-window-close-observed":
        sys.exit("requires before|after and --normal-window-close-observed")
    output = Path(__file__).absolute().parent
    out = open_directory(output)
    try:
        if os.fstat(out).st_uid != os.getuid(): raise RuntimeError("output owner changed")
        fd = os.open("install-data-" + sys.argv[1] + ".jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=out)
        digest = hashlib.sha256()
        counts = {root: dict.fromkeys(("directory", "file", "symlink", "special"), 0) for root in ROOTS}
        with os.fdopen(fd, "wb") as writer:
            for root, path in ROOTS.items():
                parent = open_directory(Path(path).parent)
                try: inspect(parent, Path(path).name, root, ".")
                finally: os.close(parent)
        print(json.dumps({"counts": counts, "sha256": digest.hexdigest()}, sort_keys=True))
    except BaseException:
        sys.exit("snapshot aborted; no authoritative digest; retain partial details")
    finally: os.close(out)

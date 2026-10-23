"""Bounded static resource inspection; never loads or executes a PE.

Consumes one existing same-build selection and explicitly selected generated RC.
The RC must come from that build's Cargo build-script-executed OUT_DIR receipt;
do not choose a newest-looking resource.rc from target. No old PE is required.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import time
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zlib

START = time.monotonic()
TOTAL_PAYLOAD = 0
INPUT_OBSERVATIONS = []
TYPE_NAMES = {3: "RT_ICON", 14: "RT_GROUP_ICON", 16: "RT_VERSION", 24: "RT_MANIFEST"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def budget():
    require(time.monotonic() - START < 240, "240-second read budget exceeded")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unpack(fmt, data, offset=0):
    require(0 <= offset <= len(data) - struct.calcsize(fmt), "truncated structure")
    return struct.unpack_from(fmt, data, offset)


class WindowsReadFiles:
    """Use one documented Win32 metadata vocabulary for path and held handles.

    CPython 3.13.7 win32_xstat maps path st_ctime to birthtime, while its
    _Py_fstat_noraise returns FILE_BASIC_INFO.ChangeTime. Do not mix those
    fields as though they were the same timestamp.
    https://github.com/python/cpython/blob/v3.13.7/Modules/posixmodule.c#L2069
    https://github.com/python/cpython/blob/v3.13.7/Python/fileutils.c#L1033
    https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info
    https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew
    """

    def __init__(self):
        import ctypes
        import msvcrt

        self.ctypes, self.msvcrt = ctypes, msvcrt
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)

        class FileId(ctypes.Structure):
            _fields_ = [("volume", ctypes.c_uint64), ("id", ctypes.c_ubyte * 16)]

        class Basic(ctypes.Structure):
            _fields_ = [(name, ctypes.c_int64) for name in ("creation", "access", "write", "change")] + [("attributes", ctypes.c_uint32)]

        class Standard(ctypes.Structure):
            _fields_ = [("allocation", ctypes.c_int64), ("size", ctypes.c_int64), ("links", ctypes.c_uint32), ("deleted", ctypes.c_ubyte), ("directory", ctypes.c_ubyte)]

        self.FileId, self.Basic, self.Standard = FileId, Basic, Standard
        self.kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        self.kernel.CreateFileW.restype = ctypes.c_void_p
        self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self.kernel.CloseHandle.restype = ctypes.c_int
        self.kernel.GetFileType.argtypes = [ctypes.c_void_p]
        self.kernel.GetFileType.restype = ctypes.c_uint32
        self.kernel.GetFileInformationByHandleEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.kernel.GetFileInformationByHandleEx.restype = ctypes.c_int

    def open(self, path):
        # OPEN_EXISTING; final component is never followed as a reparse point.
        # Deny new data-write/delete sharing for the lifetime of the original fd.
        handle = self.kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x00200000, None)
        if handle == self.ctypes.c_void_p(-1).value:
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        try:
            return self.msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise

    def snapshot(self, fd):
        handle = self.msvcrt.get_osfhandle(fd)
        require(self.kernel.GetFileType(handle) == 1, "input handle is not a disk file")
        def query(kind, structure):
            value = structure()
            if not self.kernel.GetFileInformationByHandleEx(handle, kind, self.ctypes.byref(value), self.ctypes.sizeof(value)):
                raise self.ctypes.WinError(self.ctypes.get_last_error())
            return value
        identity, basic, standard = query(18, self.FileId), query(0, self.Basic), query(1, self.Standard)
        require(any(identity.id), "input file identifier unavailable")
        return {"volumeSerialNumber": f"{identity.volume:016x}", "fileId128": bytes(identity.id).hex(), "size": standard.size, "links": standard.links, "deletePending": bool(standard.deleted), "directory": bool(standard.directory), "attributes": basic.attributes, "creation100ns": basic.creation, "lastWrite100ns": basic.write, "change100ns": basic.change}

    def path_snapshot(self, path):
        fd = self.open(path)
        try:
            return self.snapshot(fd)
        finally:
            os.close(fd)


def windows_files():
    return WindowsReadFiles() if os.name == "nt" else None


class HeldFile:
    def __init__(self, path, limit):
        self.path = Path(path).absolute()
        self.observation = {"inputName": self.path.name[:128], "pythonVersion": sys.version.split()[0], "platform": sys.platform, "stage": "path-lstat"}
        if len(INPUT_OBSERVATIONS) < 16:
            INPUT_OBSERVATIONS.append(self.observation)
        before = self.path.lstat()
        self.observation["pythonPathBefore"] = self.python_facts(before)
        require(stat.S_ISREG(before.st_mode) and not (getattr(before, "st_file_attributes", 0) & 0x400), "input is not an ordinary file")
        require(before.st_size <= limit, "input file exceeds size bound")
        self.windows = windows_files()
        self.observation["stage"] = "open-read-handle"
        self.fd = self.windows.open(self.path) if self.windows else os.open(self.path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            self.initial = os.fstat(self.fd)
            self.observation["pythonHeldAtOpen"] = self.python_facts(self.initial)
            if self.windows:
                self.observation["stage"] = "same-api-open-identity"
                self.native_initial = self.windows.snapshot(self.fd)
                self.observation["win32HeldAtOpen"] = self.native_initial
                path_snapshot = self.windows.path_snapshot(self.path)
                self.observation["win32PathAtOpen"] = path_snapshot
                self.check_windows(self.native_initial, limit)
                self.check_windows(path_snapshot, limit)
                require(self.native_initial == path_snapshot, "input path differs from original read handle")
                self.size = self.native_initial["size"]
            else:
                require(self.identity(before) == self.identity(self.initial), "input changed while opening")
                self.size = self.initial.st_size
            self.sha256 = self.hash()
            self.observation["stage"] = "held"
        except BaseException:
            os.close(self.fd)
            raise

    @staticmethod
    def identity(value):
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

    @staticmethod
    def python_facts(value):
        return {key: getattr(value, key, None) for key in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_birthtime_ns", "st_file_attributes")}

    @staticmethod
    def check_windows(value, limit):
        require(not value["directory"] and not value["deletePending"] and not (value["attributes"] & 0x400), "input handle is not an ordinary non-reparse file")
        require(0 <= value["size"] <= limit, "input file exceeds size bound")

    def verify_windows(self, phase):
        held, path = self.windows.snapshot(self.fd), self.windows.path_snapshot(self.path)
        self.observation["win32" + phase] = {"held": held, "path": path}
        self.check_windows(held, self.size)
        self.check_windows(path, self.size)
        require(held == self.native_initial == path, "input Win32 identity or metadata changed")

    def read(self, offset, length):
        budget()
        require(0 <= offset <= self.size and 0 <= length <= self.size - offset, "file extent out of bounds")
        require(length <= 32 * 1024 * 1024, "single read exceeds bound")
        os.lseek(self.fd, offset, os.SEEK_SET)
        chunks, remaining = [], length
        while remaining:
            part = os.read(self.fd, min(remaining, 1024 * 1024))
            require(bool(part), "short file read")
            chunks.append(part)
            remaining -= len(part)
        return b"".join(chunks)

    def hash(self):
        result = hashlib.sha256()
        for offset in range(0, self.size, 1024 * 1024):
            result.update(self.read(offset, min(1024 * 1024, self.size - offset)))
        return result.hexdigest()

    def finish(self):
        try:
            self.observation["stage"] = "finish-before-hash"
            if self.windows:
                self.verify_windows("BeforeFinalHash")
            else:
                after = self.path.lstat()
                require(not (getattr(after, "st_file_attributes", 0) & 0x400), "input became a reparse point")
                require(self.identity(after) == self.identity(self.initial) == self.identity(os.fstat(self.fd)), "input identity or metadata changed")
            require(self.hash() == self.sha256, "input bytes changed while reading")
            if self.windows:
                self.verify_windows("AfterFinalHash")
            self.observation["stage"] = "verified-closed"
        finally:
            os.close(self.fd)


def small_input(path, limit):
    held = HeldFile(path, limit)
    try:
        return held.read(0, held.size), {"path": str(held.path), "sha256": held.sha256, "bytes": held.size}
    finally:
        held.finish()


def bind_generated_rc(raw, repo, explicit_path):
    """Choose only this Cargo invocation's root-package build-script output."""
    data, receipt = small_input(raw / "test-build.stdout.jsonl", 32 * 1024 * 1024)
    choices = set()
    for line in data.splitlines():
        require(len(line) <= 1024 * 1024, "Cargo JSON record exceeds bound")
        if not line.strip():
            continue
        item = json.loads(line)
        if item.get("reason") != "build-script-executed":
            continue
        package = item.get("package_id", "")
        if not package.startswith("path+file:"):
            continue
        uri = urlsplit(package[len("path+"):])
        if not uri.fragment.startswith("farfold@") or uri.netloc not in ("", "localhost"):
            continue
        source = unquote(uri.path)
        if re.match(r"^/[A-Za-z]:/", source):
            source = source[1:]
        if Path(source).resolve() != (repo / "src-tauri").resolve():
            continue
        out = Path(item["out_dir"]).resolve(strict=True)
        require(out.is_relative_to(repo / "src-tauri/target/debug/build") and out.name == "out", "unexpected selected build-script output")
        candidate = out / "resource.rc"
        if candidate.is_file():
            choices.add(candidate)
    if explicit_path:
        selected = Path(explicit_path).resolve(strict=True)
        require(selected in choices, "requested RC not emitted by this Cargo invocation")
    else:
        require(len(choices) == 1, "current Cargo build has no unique generated RC; explicit same-invocation selection required")
        selected = next(iter(choices))
    return selected, receipt


def pe_resources(held):
    """Bounded PE32/PE32+ section mapping and three-level resource inventory."""
    dos = held.read(0, 64)
    require(dos[:2] == b"MZ", "missing DOS signature")
    pe = unpack("<I", dos, 60)[0]
    require(pe >= 64, "PE header overlaps DOS header")
    header = held.read(pe, 24)
    require(header[:4] == b"PE\0\0", "missing PE signature")
    machine, count, _, _, _, optional_size, characteristics = unpack("<HHIIIHH", header, 4)
    require(1 <= count <= 96 and 96 <= optional_size <= 4096, "PE header count or optional size out of bounds")
    optional = held.read(pe + 24, optional_size)
    magic = unpack("<H", optional)[0]
    require(magic in (0x10B, 0x20B), "unsupported optional header")
    directory_offset = 96 if magic == 0x10B else 112
    directory_count = unpack("<I", optional, directory_offset - 4)[0]
    require(directory_count >= 3 and directory_offset + 24 <= optional_size, "missing resource directory slot")
    root_rva, root_size = unpack("<II", optional, directory_offset + 16)
    sections = []
    for index in range(count):
        block = held.read(pe + 24 + optional_size + index * 40, 40)
        virtual_size, rva, raw_size, raw_offset = unpack("<IIII", block, 8)
        require(rva + max(virtual_size, raw_size) <= 0x100000000, "section RVA overflow")
        require(raw_offset <= held.size and raw_size <= held.size - raw_offset, "section raw extent outside file")
        sections.append((rva, virtual_size, raw_offset, raw_size))

    def map_rva(rva, size):
        require(rva + size <= 0x100000000, "resource RVA overflow")
        matches = []
        for start, virtual_size, raw_offset, raw_size in sections:
            if start <= rva and rva - start < max(virtual_size, raw_size):
                delta = rva - start
                require(delta <= raw_size and size <= raw_size - delta, "resource extent reaches unbacked section bytes")
                matches.append(raw_offset + delta)
        require(len(matches) == 1, "resource RVA mapping is missing or ambiguous")
        return matches[0]

    meta = {"machine": hex(machine), "optionalMagic": hex(magic), "dll": bool(characteristics & 0x2000), "resourceRva": root_rva, "resourceBytes": root_size, "sectionCount": count}
    if root_rva == root_size == 0:
        return meta, []
    require(root_rva != 0 and 16 <= root_size <= 32 * 1024 * 1024, "resource directory extent out of bound")
    root = map_rva(root_rva, root_size)
    visited, results = set(), []
    entries_seen = 0

    def relative(offset, size):
        require(0 <= offset <= root_size and 0 <= size <= root_size - offset, "resource-relative extent out of bounds")
        return held.read(root + offset, size)

    def name(value):
        if not value & 0x80000000:
            return value
        offset = value & 0x7FFFFFFF
        length = unpack("<H", relative(offset, 2))[0]
        require(length <= 256, "resource name too long")
        return relative(offset + 2, length * 2).decode("utf-16le", "strict")

    def walk(offset, keys):
        nonlocal entries_seen
        global TOTAL_PAYLOAD
        require(len(keys) <= 2 and offset not in visited, "resource cycle, alias or excessive depth")
        visited.add(offset)
        directory = relative(offset, 16)
        named, ids = unpack("<HH", directory, 12)
        count = named + ids
        entries_seen += count
        require(entries_seen <= 4096, "resource entry budget exceeded")
        entries = relative(offset + 16, count * 8)
        sibling_names = set()
        for index in range(count):
            label, child = unpack("<II", entries, index * 8)
            require(bool(label & 0x80000000) == (index < named), "resource named/id partition invalid")
            label = name(label)
            require(label not in sibling_names, "duplicate resource identity")
            sibling_names.add(label)
            key = keys + [label]
            if len(key) == 1 and label not in TYPE_NAMES:
                continue
            if len(key) < 3:
                require(child & 0x80000000, "resource leaf at unexpected depth")
                walk(child & 0x7FFFFFFF, key)
            else:
                require(not child & 0x80000000, "resource directory below language level")
                rva, size, codepage, reserved = unpack("<IIII", relative(child, 16))
                require(reserved == 0 and size <= 16 * 1024 * 1024, "resource entry unsupported or too large")
                TOTAL_PAYLOAD += size
                require(TOTAL_PAYLOAD <= 32 * 1024 * 1024, "total selected resource budget exceeded")
                file_offset = map_rva(rva, size)
                data = held.read(file_offset, size)
                results.append({"type": key[0], "name": key[1], "language": key[2], "codepage": codepage, "rva": rva, "fileOffset": file_offset, "size": size, "sha256": digest(data), "data": data})

    walk(0, [])
    return meta, results


def manifest_semantics(data):
    require(len(data) <= 65536, "manifest exceeds bound")
    # Decode first, so UTF-16 cannot hide a DTD/entity declaration behind NULs.
    encoding = "utf-16" if data[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-16le" if data.startswith(b"<\0") else "utf-16be" if data.startswith(b"\0<") else "utf-8-sig"
    text = data.decode(encoding, "strict").strip("\x00 \r\n\t")
    require(not re.search(r"<!DOCTYPE|<!ENTITY", text, re.I), "DTD or entity declarations forbidden")
    root = ET.fromstring(text)
    asm = "{urn:schemas-microsoft-com:asm.v1}"
    require(root.tag == asm + "assembly", "unexpected manifest root")
    identities = root.findall(asm + "dependency/" + asm + "dependentAssembly/" + asm + "assemblyIdentity")
    expected = {"type": "win32", "name": "Microsoft.Windows.Common-Controls", "version": "6.0.0.0", "processorArchitecture": "*", "publicKeyToken": "6595b64144ccf1df", "language": "*"}
    require(len(identities) == 1 and identities[0].attrib == expected, "expected single Common-Controls 6 dependency absent or changed")
    require(not any(node.tag.rsplit("}", 1)[-1] in ("trustInfo", "requestedPrivileges", "requestedExecutionLevel") for node in root.iter()), "unexpected permission declaration")

    def canonical(node):
        return [node.tag, sorted(node.attrib.items()), (node.text or "").strip(), [canonical(child) for child in node], (node.tail or "").strip()]

    return canonical(root)


def version_info(data):
    require(len(data) <= 65536, "version resource exceeds bound")
    nodes = 0

    def block(start, limit, depth):
        nonlocal nodes
        nodes += 1
        require(nodes <= 1024 and depth <= 8, "version tree exceeds bound")
        length, value_length, kind = unpack("<HHH", data, start)
        end = start + length
        require(6 <= length and end <= limit and kind in (0, 1), "version block extent/type invalid")
        cursor = start + 6
        key_start = cursor
        while cursor + 2 <= end and data[cursor:cursor + 2] != b"\0\0":
            cursor += 2
            require(cursor - key_start <= 512, "version key too long")
        require(cursor + 2 <= end, "unterminated version key")
        key = data[key_start:cursor].decode("utf-16le", "strict")
        cursor = (cursor + 2 + 3) & ~3
        value_bytes = value_length * (2 if kind == 1 else 1)
        require(cursor <= end and value_bytes <= end - cursor, "version value outside block")
        value = data[cursor:cursor + value_bytes]
        cursor = (cursor + value_bytes + 3) & ~3
        children = []
        while cursor < end:
            if end - cursor < 6:
                require(not any(data[cursor:end]), "nonzero version trailing padding")
                break
            child, following = block(cursor, end, depth + 1)
            children.append(child)
            cursor = (following + 3) & ~3
        return {"key": key, "kind": kind, "value": value, "children": children}, end

    root, end = block(0, len(data), 0)
    require(root["key"] == "VS_VERSION_INFO" and root["kind"] == 0 and len(root["value"]) == 52 and not any(data[end:]), "version root invalid")
    fixed = unpack("<13I", root["value"])
    require(fixed[:2] == (0xFEEF04BD, 0x10000), "fixed version signature invalid")
    values = {"FILEVERSION": [fixed[2] >> 16, fixed[2] & 65535, fixed[3] >> 16, fixed[3] & 65535], "PRODUCTVERSION": [fixed[4] >> 16, fixed[4] & 65535, fixed[5] >> 16, fixed[5] & 65535]}
    values.update(dict(zip(("FILEFLAGSMASK", "FILEFLAGS", "FILEOS", "FILETYPE", "FILESUBTYPE", "FILEDATEMS", "FILEDATELS"), fixed[6:])))
    tables, translation = {}, []
    require(len({child["key"] for child in root["children"]}) == len(root["children"]), "duplicate version group")
    for child in root["children"]:
        if child["key"] == "StringFileInfo":
            for table in child["children"]:
                require(re.fullmatch(r"[0-9a-fA-F]{8}", table["key"]) and table["key"] not in tables, "version language table invalid")
                strings = {}
                for item in table["children"]:
                    require(item["kind"] == 1 and not item["children"] and item["key"] not in strings, "version string invalid")
                    strings[item["key"]] = item["value"].decode("utf-16le", "strict").rstrip("\0")
                tables[table["key"].lower()] = strings
        elif child["key"] == "VarFileInfo":
            require(len(child["children"]) == 1 and child["children"][0]["key"] == "Translation", "unexpected version variable")
            raw = child["children"][0]["value"]
            require(len(raw) % 4 == 0 and len(raw) <= 64, "invalid version translation length")
            translation = [list(unpack("<HH", raw, offset)) for offset in range(0, len(raw), 4)]
        else:
            raise ValueError("unexpected version group")
    return {"fixed": values, "tables": tables, "translation": translation}


def rc_expectations(data):
    # This accepts only the current Tauri-generated shape, not arbitrary RC/C.
    text = data.decode("utf-8-sig", "strict")
    require(len(text) <= 65536 and text.startswith("#pragma code_page(65001)"), "not the selected generated UTF-8 resource.rc")
    fixed = {}
    for key in ("FILEVERSION", "PRODUCTVERSION"):
        rows = re.findall(rf"(?m)^{key}\s+(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\s*$", text)
        require(len(rows) == 1, "missing/duplicate RC fixed version")
        fixed[key] = [int(value) for value in rows[0]]
    for key in ("FILEFLAGSMASK", "FILEFLAGS", "FILEOS", "FILETYPE", "FILESUBTYPE"):
        rows = re.findall(rf"(?m)^{key}\s+(0x[0-9a-fA-F]+|\d+)\s*$", text)
        require(len(rows) == 1, "missing/duplicate RC fixed field")
        fixed[key] = int(rows[0], 0)
    fixed.update(FILEDATEMS=0, FILEDATELS=0)
    strings = {}
    for key, value in re.findall(r'^VALUE "([^"\\]+)", "([^"\\]*)"\s*$', text, re.M):
        require(key not in strings, "duplicate RC string key")
        strings[key] = value
    # Current Farfold metadata has no RC escapes. A future escaped value is an
    # explicit unsupported input, not silently omitted from comparison.
    value_rows = [line for line in text.splitlines() if line.startswith('VALUE "') and not line.startswith('VALUE "Translation"')]
    require(len(value_rows) == len(strings) and strings, "unsupported RC string syntax")
    language = re.findall(r'^BLOCK "([0-9a-fA-F]{8})"\s*$', text, re.M)
    translation = re.findall(r'^VALUE "Translation", (0x[0-9a-fA-F]+), (0x[0-9a-fA-F]+)\s*$', text, re.M)
    require(len(language) == len(translation) == 1, "unsupported RC version language shape")
    # tauri-winres canonicalizes the icon path, then escapes backslashes and
    # apostrophes in its RC string. Decode only those filename escapes; never
    # interpret arbitrary C escapes or discard an unrecognized ICON row.
    icons = re.findall(r'^(\d+) ICON "((?:[^"\\\r\n]|\\[\\\'])*)"[ \t\r]*$', text, re.M)
    icon_rows = [row for row in text.splitlines() if re.match(r'^\S+\s+ICON\b', row)]
    require(len(icon_rows) == len(icons), "unsupported RC icon string syntax")
    require(len(icons) == 1 and int(icons[0][0]) == 32512, "unexpected RC icon identity/path syntax")
    icon_path = re.sub(r"\\([\\'])", lambda match: match[1], icons[0][1])
    require(icon_path and not any(ord(char) < 32 for char in icon_path), "invalid RC icon filename")
    return {"fixed": fixed, "tables": {language[0].lower(): strings}, "translation": [[int(value, 0) for value in translation[0]]]}, icon_path


def resource_icon_fields(image, fields):
    if not image.startswith(b"\x89PNG\r\n\x1a\n"):
        return fields.copy()
    # PNG icon resources use one plane and 32 bits per pixel, rather than
    # copying the ICO directory's unspecified (zero) plane count. Only the
    # verified RGBA8 shape used by this source icon receives that conversion.
    require(fields[4] in (0, 1) and fields[5] == 32, "unsupported PNG icon directory format")
    cursor, chunks, saw_data, ended = 8, 0, False, False
    while cursor < len(image):
        require(chunks < 4096 and len(image) - cursor >= 12, "PNG chunk extent/count invalid")
        size = unpack(">I", image, cursor)[0]
        require(size <= len(image) - cursor - 12, "truncated PNG chunk")
        kind = image[cursor + 4:cursor + 8]
        payload = image[cursor + 8:cursor + 8 + size]
        require(unpack(">I", image, cursor + 8 + size)[0] == zlib.crc32(kind + payload), "PNG chunk CRC mismatch")
        if chunks == 0:
            require(kind == b"IHDR" and size == 13, "PNG header missing")
            width, height, depth, color, compression, filtering, interlace = unpack(">IIBBBBB", payload)
            require((width, height) == (fields[0] or 256, fields[1] or 256), "PNG icon dimensions differ")
            require((depth, color, compression, filtering) == (8, 6, 0, 0) and interlace in (0, 1), "unsupported PNG icon pixels")
        elif kind == b"IDAT":
            require(size > 0 and not ended, "invalid PNG image data")
            saw_data = True
        elif kind == b"IEND":
            require(size == 0 and saw_data and cursor + 12 == len(image), "invalid PNG end")
            ended = True
        else:
            # The checked source images contain only IHDR/IDAT/IEND. Future
            # formats are explicit unsupported input, not unchecked aliases.
            raise ValueError("unsupported PNG icon chunk")
        cursor += size + 12
        chunks += 1
    require(ended, "PNG end missing")
    return fields[:4] + [1] + fields[5:]


def icon_entries(data, group=False):
    require(unpack("<HH", data) == (0, 1), "invalid icon header")
    count = unpack("<H", data, 4)[0]
    width = 14 if group else 16
    require(1 <= count <= 256 and 6 + count * width <= len(data), "icon entry extent invalid")
    if group:
        require(6 + count * width == len(data), "unexpected group icon trailing bytes")
    entries = []
    for index in range(count):
        offset = 6 + index * width
        fields = list(unpack("<BBBBHHI", data, offset))
        require(fields[3] == 0, "icon reserved field not zero")
        position = unpack("<H" if group else "<I", data, offset + 12)[0]
        result = {"fields": fields, "id" if group else "offset": position}
        if not group:
            require(position >= 6 + count * width and position <= len(data) and fields[6] <= len(data) - position, "ICO image outside file")
            image = data[position:position + fields[6]]
            result["sha256"] = digest(image)
            result["resourceFields"] = resource_icon_fields(image, fields)
        entries.append(result)
    return entries


def icon_resources_match(resources, expected_icons):
    groups = [resource for resource in resources if resource["type"] == 14]
    icon_match = bool(groups)
    for group in groups:
        entries = icon_entries(group["data"], group=True)
        icon_match &= group["name"] == 32512 and len(entries) == len(expected_icons)
        for index, entry in enumerate(entries):
            icons = [item for item in resources if item["type"] == 3 and item["name"] == entry["id"] and item["language"] == group["language"]]
            icon_match &= len(icons) == 1 and index < len(expected_icons)
            if len(icons) == 1 and index < len(expected_icons):
                icon_match &= entry["fields"] == expected_icons[index]["resourceFields"] and icons[0]["size"] == entry["fields"][6] and icons[0]["sha256"] == expected_icons[index]["sha256"]
    return icon_match


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-directory", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--baseline-helper-manifest", required=True)
    parser.add_argument("--generated-resource-rc", help="Only needed if the current Cargo JSON has multiple root-package OUT_DIRs")
    args = parser.parse_args()
    require(re.fullmatch(r"[0-9a-f]{40}", args.expected_head), "invalid source head")
    repo = Path.cwd().resolve()
    raw = Path(args.raw_directory).resolve(strict=True)
    require(raw.is_relative_to(repo), "raw directory outside checkout")
    output = raw / "pe-resource-evidence"
    output.mkdir(exist_ok=False)
    report = {"sourceHead": args.expected_head, "parserCompleted": False, "staticChecks": {}, "images": {}, "limits": {"seconds": 240, "peBytesEach": 2147483648, "selectedResourceBytesTotal": 33554432, "resourceEntriesEach": 4096}, "scope": "Static same-build PE resource evidence only; not program startup, Windows UI, screenshot or recovery acceptance."}
    try:
        selection_bytes, selection_receipt = small_input(raw / "build-selection.json", 65536)
        selection = json.loads(selection_bytes)
        require(selection["sourceHead"] == args.expected_head, "build selection source mismatch")
        baseline, baseline_receipt = small_input(args.baseline_helper_manifest, 65536)
        expected_manifest = manifest_semantics(baseline)
        rc_path, cargo_receipt = bind_generated_rc(raw, repo, args.generated_resource_rc)
        rc, rc_receipt = small_input(rc_path, 65536)
        # Preserve the exact selected input even if its syntax is unsupported.
        # This is evidence of the input, not a successful resource comparison.
        report["inputs"] = {"selection": selection_receipt, "baselineManifest": baseline_receipt, "candidateGeneratedRc": rc_receipt, "cargoJson": cargo_receipt, "rcProvenance": "Exact root-package build-script-executed OUT_DIR in this invocation's test-build.stdout.jsonl; never directory freshness."}
        (output / "baseline-helper.manifest.xml").write_bytes(baseline)
        (output / "candidate-resource.rc").write_bytes(rc)
        expected_version, icon_name = rc_expectations(rc)
        icon_path = (repo / "src-tauri" / icon_name).absolute()
        require(icon_path.resolve() == (repo / "src-tauri/icons/icon.ico").resolve(), "RC icon differs from current Tauri fallback icon")
        ico, ico_receipt = small_input(icon_path, 16 * 1024 * 1024)
        expected_icons = icon_entries(ico)
        report["inputs"]["sourceIco"] = ico_receipt
        report["expectedVersion"] = expected_version
        report["sourceIconFrames"] = expected_icons
        roles = [("helper", "helperBinary", "helperBinarySha256", 1), ("libtest", "testBinary", "testBinarySha256", 1)]
        cdylib_expected = selection.get("cdylibExpected", False)
        require(type(cdylib_expected) is bool, "cdylibExpected must be a boolean")
        if cdylib_expected or selection.get("cdylibBinary") is not None or selection.get("cdylibBinarySha256") is not None:
            require(isinstance(selection.get("cdylibBinary"), str) and bool(selection["cdylibBinary"]) and isinstance(selection.get("cdylibBinarySha256"), str) and re.fullmatch(r"[0-9a-fA-F]{64}", selection["cdylibBinarySha256"]), "expected/current cdylib selection is missing or invalid; see build-selection.json cdylibSelectionError")
            roles.append(("cdylib", "cdylibBinary", "cdylibBinarySha256", 2))
        else:
            report["cdylib"] = "not selected in this build receipt; not inferred from stale target files"
        for role, path_key, hash_key, expected_id in roles:
            path = Path(selection[path_key]).absolute()
            resolved = path.resolve(strict=True)
            debug = repo / "src-tauri/target/debug"
            require(resolved.is_relative_to(debug), "selected PE outside debug target")
            if role == "helper":
                require(resolved == debug / "farfold.exe", "unexpected helper path")
            elif role == "libtest":
                require(resolved.parent == debug / "deps" and re.fullmatch(r"farfold_lib-[0-9a-f]+\.exe", resolved.name), "unexpected libtest path")
            else:
                require(resolved in (debug / "farfold_lib.dll", debug / "deps/farfold_lib.dll"), "unexpected selected cdylib path")
            held = HeldFile(path, 2147483648)
            image = {"path": str(path), "sha256": held.sha256, "bytes": held.size, "resources": []}
            report["images"][role] = image
            try:
                require(re.fullmatch(r"[0-9a-fA-F]{64}", selection[hash_key]) and held.sha256 == selection[hash_key].lower(), "selected PE hash mismatch")
                image["pe"], resources = pe_resources(held)
                require(image["pe"]["dll"] == (role == "cdylib"), "PE DLL characteristic mismatches role")
                for index, resource in enumerate(resources):
                    payload = resource.pop("data")
                    resource["file"] = f"{role}-{index:03}-{TYPE_NAMES[resource['type']]}.bin"
                    (output / resource["file"]).write_bytes(payload)
                    resource["data"] = payload
                    image["resources"].append({key: value for key, value in resource.items() if key != "data"})
                manifests = [resource for resource in resources if resource["type"] == 24]
                manifest_match = bool(manifests)
                for resource in manifests:
                    manifest_match &= resource["name"] == expected_id and manifest_semantics(resource["data"]) == expected_manifest
                report["staticChecks"][role + "ManifestMatchesBaselineAtExpectedId"] = manifest_match
                if role == "helper":
                    versions = [resource for resource in resources if resource["type"] == 16]
                    image["decodedVersions"] = [version_info(resource["data"]) for resource in versions]
                    report["staticChecks"]["helperVersionMatchesGeneratedRc"] = bool(versions) and all(value == expected_version for value in image["decodedVersions"])
                    report["staticChecks"]["helperIconGroupsAndImageBytesMatchSourceIco"] = icon_resources_match(resources, expected_icons)
            finally:
                held.finish()
                image["inputUnchanged"] = True
        report["parserCompleted"] = True
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        report["inputObservations"] = INPUT_OBSERVATIONS
        report["elapsedSeconds"] = round(time.monotonic() - START, 3)
        report["staticChecksAllMatched"] = report["parserCompleted"] and bool(report["staticChecks"]) and all(report["staticChecks"].values())
        (output / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if report["staticChecksAllMatched"] else 1


if __name__ == "__main__":
    sys.exit(main())

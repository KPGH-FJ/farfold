"""Rehydrate unchanged production sharing modules for standalone Rust module lookup.
These generated copies are build inputs, not archived source forks.
"""
from pathlib import Path
import shutil
ROOT = Path(__file__).resolve().parent
SOURCE = Path('/Users/tw/Desktop/farfold/src-tauri/src')
for name in ['browser_sharing.rs','browser_sharing/helper.rs','browser_sharing/permission.rs','browser_sharing/protocol.rs','browser_sharing/transport.rs']:
    target = ROOT / name
    target.parent.mkdir(exist_ok=True, parents=True)
    shutil.copyfile(SOURCE / name, target)

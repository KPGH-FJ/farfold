from pathlib import Path
import hashlib, json, sys

ROOT = Path(__file__).resolve().parent
REPO = Path('/Users/tw/Desktop/farfold')
PRODUCTION = [
    'src-tauri/src/browser_workspace.rs',
    'src-tauri/src/browser_workspace/local_html.rs',
    'src-tauri/src/file_delivery.rs',
    'src-tauri/src/file_delivery_commands.rs',
    'src-tauri/src/browser_workspace/native.rs',
    'src-tauri/src/browser_workspace/page_read.rs',
    'src-tauri/src/browser_workspace/policy.rs',
    'src-tauri/src/browser_sharing.rs',
    'src-tauri/src/browser_sharing/helper.rs',
    'src-tauri/src/browser_sharing/protocol.rs',
    'src-tauri/src/browser_sharing/permission.rs',
    'src-tauri/src/browser_sharing/transport.rs',
    'src-tauri/src/acp_client/transient_mcp.rs',
    'src-tauri/native/BrowserWorkspace.m',
    'src-tauri/native/BrowserWorkspace.h',
]
HARNESS = ['probe.rs', 'context.rs', 'workflow.js', 'native/Witness.m', 'native/Witness.h', 'build.sh', 'manifest.py', 'run_probe.py']

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def inputs():
    for name in ["browser_sharing.rs", "browser_sharing/helper.rs", "browser_sharing/permission.rs", "browser_sharing/protocol.rs", "browser_sharing/transport.rs"]:
        assert digest(ROOT / name) == digest(REPO / "src-tauri/src" / name), "module copy differs from production"

    return {'production': {name: digest(REPO / name) for name in PRODUCTION},
            'harness': {name: digest(ROOT / name) for name in HARNESS}}

if __name__ == '__main__':
    phase = sys.argv[1]
    current = inputs()
    if phase == 'before':
        (ROOT / 'results/build-before.json').write_text(json.dumps(current, indent=2) + '\n')
    elif phase == 'after':
        before = json.loads((ROOT / 'results/build-before.json').read_text())
        if before != current:
            raise SystemExit('source changed during compile; candidate rejected')
        current['binarySha256'] = digest(ROOT / 'sharing-probe')
        (ROOT / 'results/build-inputs.json').write_text(json.dumps(current, indent=2) + '\n')
    else:
        raise SystemExit('unknown manifest phase')

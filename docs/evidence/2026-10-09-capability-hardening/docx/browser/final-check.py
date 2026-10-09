"""Freeze relevant inputs around two real browser regressions; own processes only."""
from pathlib import Path
import hashlib, json, subprocess, sys
repo = Path(__file__).resolve().parents[5]
base = repo / 'docs/evidence/2026-10-09-capability-hardening/docx'
owned = sorted(repo.glob('src/runtime/docx_*.ts')) + [repo / 'src/workers/docx_preview.worker.ts']
ui = [repo / p for p in ['src/components/DocxFilePreview.tsx', 'src/components/DocxDocumentView.tsx', 'src/components/DocxFilePreview.css', 'src/runtime/document_view.ts', 'src/runtime/document_images.ts', 'src/runtime/document_strings.ts']]
inputs = owned + [p for p in ui if p.exists()]
def hashes():
    return {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
before = hashes()
node = '/Users/tw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
tag = sys.argv[1] if len(sys.argv) > 1 else "closed"
results = []
for subdir, name in [('browser', 'worker-' + tag), ('ui-browser', 'ui-' + tag)]:
    with (base / subdir / (name + '.txt')).open('w') as output:
        result = subprocess.run([node, str(base / subdir / 'run.mjs'), name], cwd=repo, stdout=output, stderr=subprocess.STDOUT, timeout=70)
    results.append(dict(log=subdir + '/' + name + '.txt', exitCode=result.returncode))
after = hashes()
(base / (tag + '-browser-inputs.json')).write_text(json.dumps(dict(before=before, after=after, sourceUnchanged=before == after, runs=results), indent=2) + '\n')
print(json.dumps(dict(sourceUnchanged=before == after, runs=results)))
raise SystemExit(0 if before == after and all(r['exitCode'] == 0 for r in results) else 1)

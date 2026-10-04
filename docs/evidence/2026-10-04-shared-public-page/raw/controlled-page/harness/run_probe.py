from pathlib import Path
import datetime, json, os, signal, subprocess
from manifest import ROOT, digest, inputs

baseline = json.loads((ROOT / 'results/build-inputs.json').read_text())
actual = inputs()
actual['binarySha256'] = digest(ROOT / 'sharing-probe')
assert baseline == actual, 'compiled sources changed before execution'
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
result = ROOT / 'results' / f'sharing-{stamp}.json'
log = ROOT / 'results' / f'sharing-{stamp}.log'
timed_out = False
with log.open('x') as stream:
    run = subprocess.Popen([str(ROOT / 'sharing-probe'), str(result)], cwd=ROOT,
                           stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        run.wait(timeout=65)
    except subprocess.TimeoutExpired:
        timed_out = True
        # Only the new process group created for this controlled probe.
        os.killpg(run.pid, signal.SIGTERM)
        try:
            run.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(run.pid, signal.SIGKILL)
            run.wait(timeout=3)
after = inputs()
after['binarySha256'] = digest(ROOT / 'sharing-probe')
unchanged = baseline == after
receipt = {'result': str(result), 'processExit': run.returncode, 'sourceUnchanged': unchanged, 'timedOut': timed_out,
           'binarySha256': baseline['binarySha256'], 'inputs': baseline}
if result.exists():
    data = json.loads(result.read_text())
    receipt.update({'pass': data['pass'] and unchanged and run.returncode == 0,
                    'steps': data['report'].get('steps'), 'error': data['report'].get('error'),
                    'cleanup': data['report'].get('cleanup'), 'cleanupError': data['report'].get('cleanupError'), 'nativeDetached': data['nativeDetached']})
else:
    receipt.update({'pass': False, 'error': 'result missing'})
receipt_path = ROOT / 'results' / f'receipt-{stamp}.json'
receipt_path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({key: value for key, value in receipt.items() if key != 'inputs'}, ensure_ascii=False))

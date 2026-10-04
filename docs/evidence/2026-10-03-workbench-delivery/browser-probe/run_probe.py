"""Run only this directory's synthetic native probe, with a hard time bound."""
import json
import pathlib
import subprocess

probe_dir = pathlib.Path(__file__).resolve().parent
previous = probe_dir / "result.json"
before = previous.stat().st_mtime_ns if previous.exists() else None
with (probe_dir / "execution-rerun.log").open("w") as output:
    try:
        result = subprocess.run(
            [str(probe_dir / "wk-controlled-probe"), str(probe_dir)],
            stdout=output,
            stderr=subprocess.STDOUT,
            timeout=35,
            check=False,
        )
        fresh = previous.exists() and previous.stat().st_mtime_ns != before
        print(json.dumps({"exit_code": result.returncode, "fresh_result": fresh}))
        if result.returncode != 0 or not fresh:
            raise SystemExit(1)
    except subprocess.TimeoutExpired:
        print(json.dumps({"blocked": "native_probe_timeout_35_seconds"}))
        raise SystemExit(1)

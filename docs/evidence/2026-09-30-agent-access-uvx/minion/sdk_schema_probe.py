"""One authorized SDK-only import check; never imports or runs Minion."""

import importlib
import importlib.metadata
import json
import sys
from pathlib import Path

CACHE = Path(
    "/Users/tw/Library/Application Support/ai.farfold.desktop/uv/cache/archive-v0"
)
ROOTS = (
    "BiwflEjzmXY-a5jv",  # agent-client-protocol 0.12.1
    "TrYdXUo6EAe-plW4",  # pydantic 2.13.5
    "URMDW0-I_7ny-mv9",  # pydantic-core 2.46.5
    "s4rljM5wPzbHrCW7",  # annotated-types 0.8.0
    "XbO962GgzSRLqTxy",  # typing-extensions 4.16.0
    "p_GpABf9Q0JEhWGd",  # typing-inspection 0.4.4
)
SYMBOLS = ("ModelInfo", "SessionModelState", "SetSessionModelResponse")


def main():
    sys.path[:0] = [str(CACHE / name) for name in ROOTS]
    report = {
        "kind": "independent-official-sdk-schema-import",
        "usedPackageStub": False,
        "minionImported": False,
        "pythonVersion": ".".join(map(str, sys.version_info[:3])),
        "sdkVersion": importlib.metadata.version("agent-client-protocol"),
        "symbols": [],
    }
    try:
        schema = importlib.import_module("acp.schema")
        report["schemaImport"] = "completed"
        report["schemaMatchesCache"] = (
            Path(schema.__file__).resolve()
            == (CACHE / ROOTS[0] / "acp/schema.py").resolve()
        )
        for name in SYMBOLS:
            try:
                exec(f"from acp.schema import {name}", {})
                report["symbols"].append({"name": name, "imported": True})
            except ImportError:
                report["symbols"].append(
                    {"name": name, "imported": False, "errorType": "ImportError"}
                )
    except Exception as error:
        report["schemaImport"] = "failed"
        report["errorType"] = type(error).__name__
    report["minionImported"] = any(
        name == "minion_code" or name.startswith("minion_code.")
        for name in sys.modules
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["schemaImport"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())

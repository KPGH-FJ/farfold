# Pi ACP Adapter Source

Imported from https://github.com/svkozak/pi-acp at commit
`1bfcb394088ed879db8fd936b570bb626017f878` (`pi-acp@0.0.33`).
Source archive SHA-256: `1fc83aa7247368bbddef410a67cc56317f9cb0fd6df54c343af27a7f36b16dc3`.
The original MIT license is preserved in LICENSE. Upstream source and tests are
retained; publisher workflows and unrelated smoke scripts are not imported.

The user approved finite adapter extensions on 2026-09-12. Pi itself remains the
official, unmodified 0.84.3 executable. ACP SDK 0.26.0, Zod 3.25.76 and Node 22.22.3
are the initial fixed combination. This directory is not yet an installed product
capability. Changes and acceptance are tracked in the existing Farfold active plan
and implementation record, not in a second plan here.

The maintained adapter embeds a finite official Pi Extension for same-process
model-registry refresh. It creates a private temporary source file for each Pi
process and passes it through the official `--extension` flag. The source is part
of the verified adapter bundle, not a separately downloaded executable. The
negotiated `_pi/refresh_profile` operation verifies registered command provenance,
native idle/session identity and its private acknowledgement; it is not an Agent
turn, authentication success, Provider application or request verification.
Unknown refresh outcomes close the logical connection and request process
termination; confirmed process exit remains a separate lifecycle responsibility.

The negotiated `promptModel` contract carries an exact native Session/file/model
expectation into ordinary prompt dispatch. A bounded native `get_state` check and
adapter mutation guard precede the original RPC prompt write; abort invalidates a
pending check, and valid UI answers are retained. Only pre-write failures carry the
explicit not-sent result. Transport failures or malformed acknowledgements after
the prompt write keep the logical session unknown. This is adapter-side exclusion,
not an atomic model constraint inside arbitrary Runtime extensions. Built-in slash
commands retain their native-specific handling and do not fabricate model receipts.

Cold restore captures the original file before Pi starts. It uses only the pinned
SDK's public `parseSessionEntries`/`buildSessionContext` for branch/model semantics,
with bounded regular-file, header, parent-chain and malformed-container checks.
Static `ModelRuntime` catalog inspection and exact `resolveCliModel` resolution
reject missing or synthesized fallback selectors without login, token refresh or
model calls. The SDK is explicitly located beside the verified capability-runtime
Node executable, in both source and staged application resource layouts; no cwd or
global module search is used. Missing/wrong SDK resources block recovery.

The original selector is supplied to Pi's official CLI. A private Extension
observation then checks the original model and branch, native identity and idle
state, while the adapter checks the original file prefix and inode. This prevents
the fixed Pi empty-message startup path from replacing the authority with a newly
written default model. It does not lock out arbitrary external file/config writers
or repair history. Unknown formats/models, including extension-only models absent
from the static catalog, remain explicitly blocked, not claimed as preserved.

ACP SDK and Zod are bundled rather than resolved from a source checkout; their
licenses are included in the application resources. Adapter name/version are
embedded from this package at build time, not discovered from a nearby package.
Isolated bundle checks are engineering evidence, not installed D acceptance.

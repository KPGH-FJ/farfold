import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { loadPiSdk } from './sdk.js'
import {
  NATIVE_FIRST_USE_ENTRY,
  hasControlCharacters,
  parseNativeFirstUseState,
  type PiNativeFirstUseState
} from '../acp/native-first-use.js'

export class PiModelRestoreMismatchError extends Error {
  constructor(readonly reason: 'model_mismatch' | 'parser_unavailable' | 'history_unavailable' = 'model_mismatch') {
    super('Pi original model recovery was blocked')
  }
}

type Model = { provider: string; modelId: string }
type Identity = { sessionId: string; sessionFile: string; cwd: string }
const MAX_HISTORY_BYTES = 64 * 1024 * 1024

// Both development and packaged launches use the verified capability-runtime Node layout.
// Do not resolve an SDK from cwd, global Node modules, or the user's Pi installation.
export async function loadRestoreSdk(nodePath = process.execPath) {
  try {
    const sdk = await loadPiSdk(nodePath)
    for (const name of ['parseSessionEntries', 'buildSessionContext', 'resolveCliModel'])
      if (typeof sdk[name] !== 'function') throw new Error()
    if (sdk.CURRENT_SESSION_VERSION !== 3 || typeof sdk.ModelRuntime?.create !== 'function') throw new Error()
    return sdk
  } catch {
    throw new PiModelRestoreMismatchError('parser_unavailable')
  }
}

function readSnapshot(path: string) {
  let fd: number | undefined
  try {
    if (!isAbsolute(path)) throw new Error()
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size === 0 || before.size > MAX_HISTORY_BYTES) throw new Error()
    const content = Buffer.alloc(before.size)
    let offset = 0
    while (offset < content.length) {
      const count = readSync(fd, content, offset, content.length - offset, offset)
      if (!count) throw new Error()
      offset += count
    }
    const after = fstatSync(fd)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error()
    return { content, dev: before.dev, ino: before.ino }
  } catch {
    throw new PiModelRestoreMismatchError('history_unavailable')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function digest(content: Buffer) {
  return createHash('sha256').update(content).digest('hex')
}

export async function prepareRestoreSource(identity: Identity, sdkLoader = loadRestoreSdk) {
  const snapshot = readSnapshot(identity.sessionFile)
  const sdk = await sdkLoader()
  let model: Model | null = null
  let leafId: string
  let nativeFirstUse: PiNativeFirstUseState | null = null
  try {
    // Validate the container before invoking the native parser, which tolerates bad lines
    // and assumes an acyclic parent chain. Branch and model semantics remain native.
    const content = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.content)
    const records = content
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line))
    const [header, ...entries] = records
    if (
      header?.type !== 'session' ||
      header.version !== 3 ||
      header.id !== identity.sessionId ||
      typeof header.cwd !== 'string' ||
      !isAbsolute(header.cwd) ||
      resolve(header.cwd) !== resolve(identity.cwd)
    )
      throw new Error()
    const ids = new Set<string>()
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.type !== 'string' ||
        entry.type === 'session' ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        entry.id.length > 512 ||
        ids.has(entry.id) ||
        (entry.parentId !== null && !ids.has(entry.parentId))
      )
        throw new Error()
      ids.add(entry.id)
    }
    const parsed = sdk.parseSessionEntries(content)
    if (parsed.length !== records.length) throw new Error()
    const history = sdk.buildSessionContext(parsed.slice(1))
    leafId = entries.at(-1)?.id
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    let branchEntry = leafId ? byId.get(leafId) : undefined
    while (branchEntry) {
      if (branchEntry.type === 'custom' && branchEntry.customType === NATIVE_FIRST_USE_ENTRY) {
        nativeFirstUse = parseNativeFirstUseState(branchEntry.data)
        if (!nativeFirstUse) throw new Error()
        break
      }
      branchEntry = branchEntry.parentId === null ? undefined : byId.get(branchEntry.parentId)
    }
    model = history.model ?? null
    if (model) {
      if (
        typeof model.provider !== 'string' ||
        !model.provider ||
        model.provider.length > 200 ||
        model.provider.includes('/') ||
        typeof model.modelId !== 'string' ||
        !model.modelId ||
        `${model.provider}/${model.modelId}`.length > 512 ||
        hasControlCharacters(`${model.provider}${model.modelId}`)
      )
        throw new Error()
    }
    if (!nativeFirstUse && !model) throw new Error()
    if (
      nativeFirstUse?.phase === 'ready' &&
      (!model || model.provider !== nativeFirstUse.provider || model.modelId !== nativeFirstUse.modelId)
    )
      throw new Error()
  } catch {
    throw new PiModelRestoreMismatchError('history_unavailable')
  }
  if (model && (!nativeFirstUse || nativeFirstUse.phase === 'ready')) {
    try {
      const agentDir = process.env.PI_CODING_AGENT_DIR
      if (!agentDir || !isAbsolute(agentDir)) throw new Error()
      // Static catalog/config only: no OAuth refresh, authentication request, model call,
      // or SDK AgentSession. Exact CLI resolution must not become a fuzzy fallback.
      const runtime = await sdk.ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: join(agentDir, 'models.json'),
        refreshOnCreate: false,
        allowModelNetwork: false
      })
      const resolved = sdk.resolveCliModel({
        cliProvider: model.provider,
        cliModel: model.modelId,
        modelRuntime: runtime
      })
      if (
        resolved.error ||
        resolved.warning ||
        !runtime
          .getModels()
          .some(
            (candidate: { provider: string; id: string }) =>
              candidate.provider === model.provider && candidate.id === model.modelId
          ) ||
        resolved.model?.provider !== model.provider ||
        resolved.model?.id !== model.modelId
      )
        throw new Error()
    } catch {
      throw new PiModelRestoreMismatchError()
    }
  }
  const hash = digest(snapshot.content)
  const assertUnchanged = (allowNativeAppend = false) => {
    const current = readSnapshot(identity.sessionFile)
    if (
      current.dev !== snapshot.dev ||
      current.ino !== snapshot.ino ||
      (!allowNativeAppend && current.content.length !== snapshot.content.length) ||
      current.content.length < snapshot.content.length ||
      digest(current.content.subarray(0, snapshot.content.length)) !== hash
    )
      throw new PiModelRestoreMismatchError('history_unavailable')
  }
  assertUnchanged()
  return { model, leafId, nativeFirstUse, assertUnchanged }
}

export type PiRestoreSource = Awaited<ReturnType<typeof prepareRestoreSource>>

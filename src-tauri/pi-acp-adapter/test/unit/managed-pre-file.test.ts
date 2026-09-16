import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManagedPreFile, requireManagedPreFile, verifyEmptyManagedState } from '../../src/acp/managed-pre-file.js'
import { SessionStore } from '../../src/acp/session-store.js'

test('managed empty proof rejects missing, ownership/version/model drift, unknown shape and existing history; consume is durable', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pi-proof-'))
  const dir = process.env.PI_CODING_AGENT_DIR
  const env = process.env.FARFOLD_PI_MANAGED_PRE_FILE
  const anchor = { version: 1 as const, binding: 'a'.repeat(64), provider: 'managed', modelId: 'model' }
  try {
    mkdirSync(join(root, 'agent'), { mode: 0o700 })
    mkdirSync(join(root, 'sessions'))
    process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
    const file = join(root, 'sessions', 'empty.jsonl')
    delete process.env.FARFOLD_PI_MANAGED_PRE_FILE
    assert.throws(() => requireManagedPreFile(anchor, file))
    for (const changed of [
      { ...anchor, binding: 'b'.repeat(64) },
      { ...anchor, modelId: 'other' },
      { ...anchor, provider: 'other' },
      { ...anchor, version: 2 },
      { ...anchor, unknown: true }
    ]) {
      process.env.FARFOLD_PI_MANAGED_PRE_FILE = JSON.stringify(changed)
      assert.throws(() => requireManagedPreFile(anchor, file))
    }
    assert.equal(parseManagedPreFile({ ...anchor, nativeFirstUse: {} }), null)
    process.env.FARFOLD_PI_MANAGED_PRE_FILE = JSON.stringify(anchor)
    requireManagedPreFile(anchor, file)
    assert.throws(() => requireManagedPreFile(anchor, join(root, 'outside.jsonl')))
    writeFileSync(file, 'existing-history')
    assert.throws(() => requireManagedPreFile(anchor, file))
    const store = new SessionStore(join(root, 'map.json'))
    store.upsert({ sessionId: 'original', cwd: root, sessionFile: file, managedPreFile: anchor })
    assert.deepEqual(store.get('original')?.managedPreFile, anchor)
    store.consumeManagedPreFile('original')
    store.upsert({ sessionId: 'original', cwd: root, sessionFile: file })
    assert.equal(new SessionStore(join(root, 'map.json')).get('original')?.managedPreFile, undefined)
  } finally {
    if (dir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = dir
    if (env === undefined) delete process.env.FARFOLD_PI_MANAGED_PRE_FILE
    else process.env.FARFOLD_PI_MANAGED_PRE_FILE = env
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed empty proof refuses non-idle, unknown state, messages, absent catalog and default model', () => {
  const anchor = { version: 1 as const, binding: 'a'.repeat(64), provider: 'managed', modelId: 'model' }
  const state = {
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    model: { provider: anchor.provider, id: anchor.modelId }
  }
  const messages = { messages: [] }
  const models = { models: [state.model] }
  verifyEmptyManagedState(state, messages, models, anchor)
  for (const altered of [
    { ...state, isStreaming: true },
    { ...state, isCompacting: true },
    { ...state, pendingMessageCount: 1 },
    { ...state, pendingMessageCount: undefined },
    { ...state, model: { provider: 'default', id: 'model' } }
  ])
    assert.throws(() => verifyEmptyManagedState(altered, messages, models, anchor))
  assert.throws(() => verifyEmptyManagedState(state, { messages: [{}] }, models, anchor))
  assert.throws(() => verifyEmptyManagedState(state, messages, { models: [] }, anchor))
})

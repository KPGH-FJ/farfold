import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRestoreSdk, prepareRestoreSource, PiModelRestoreMismatchError } from '../../src/pi-rpc/restore-source.js'

const nodePath = fileURLToPath(new URL('../../../capability-bridge/runtime/node', import.meta.url))
const loadSdk = () => loadRestoreSdk(nodePath)

test('fixed public parser captures the original empty branch, rejects damaged files and exact-model fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-restore-source-'))
  const sessionFile = join(root, 'session.jsonl')
  const identity = { sessionId: 'native', sessionFile, cwd: root }
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const entries = [
    { type: 'session', version: 3, id: 'native', cwd: root },
    { type: 'model_change', id: 'root', parentId: null, provider: 'fixture', modelId: 'original' },
    { type: 'model_change', id: 'different', parentId: 'root', provider: 'fixture', modelId: 'default' },
    { type: 'model_change', id: 'leaf', parentId: 'root', provider: 'fixture', modelId: 'original' }
  ]
  const encode = (records: unknown[]) => records.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  const original = encode(entries)
  try {
    writeFileSync(
      join(root, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: 'http://127.0.0.1:1',
            api: 'openai-completions',
            apiKey: 'synthetic-unused-key',
            models: ['default', 'original'].map(id => ({
              id,
              name: id,
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024
            }))
          }
        }
      })
    )
    writeFileSync(sessionFile, original)
    const source = await prepareRestoreSource(identity, loadSdk)
    assert.deepEqual(source.model, { provider: 'fixture', modelId: 'original' })
    assert.equal(readFileSync(sessionFile, 'utf8'), original)
    writeFileSync(
      sessionFile,
      original +
        JSON.stringify({ type: 'thinking_level_change', id: 'new', parentId: 'leaf', thinkingLevel: 'off' }) +
        '\n'
    )
    assert.throws(() => source.assertUnchanged(), PiModelRestoreMismatchError)
    source.assertUnchanged(true)
    writeFileSync(sessionFile, original.replace('original', 'modified'))
    assert.throws(() => source.assertUnchanged(true), PiModelRestoreMismatchError)
    for (const corrupt of [
      original + '{broken}\n',
      encode([{ ...entries[0], version: 2 }, ...entries.slice(1)]),
      encode([{ ...entries[0], id: 'wrong' }, ...entries.slice(1)]),
      encode([entries[0], { ...entries[1], parentId: 'root' }]),
      encode([entries[0], entries[1], entries[1]]),
      encode([entries[0], { ...entries[1], parentId: 'missing' }]),
      encode([entries[0]]),
      encode([...entries.slice(0, -1), { ...entries[3], modelId: 'missing-model' }])
    ]) {
      writeFileSync(sessionFile, corrupt)
      await assert.rejects(prepareRestoreSource(identity, loadSdk), PiModelRestoreMismatchError)
      assert.equal(readFileSync(sessionFile, 'utf8'), corrupt)
    }
    writeFileSync(sessionFile, original)
    const alias = join(root, 'alias.jsonl')
    symlinkSync(sessionFile, alias)
    await assert.rejects(
      prepareRestoreSource({ ...identity, sessionFile: alias }, loadSdk),
      PiModelRestoreMismatchError
    )
    await assert.rejects(
      loadRestoreSdk(join(root, 'runtime/node')),
      error => error instanceof PiModelRestoreMismatchError && error.reason === 'parser_unavailable'
    )
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('pending native first-use marker restores the exact empty branch without resolving a default model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-native-first-use-'))
  const sessionFile = join(root, 'session.jsonl')
  const identity = { sessionId: 'native-first-use', sessionFile, cwd: root }
  const records = [
    { type: 'session', version: 3, id: identity.sessionId, cwd: root },
    {
      type: 'custom',
      id: 'pending',
      parentId: null,
      customType: 'farfold-native-first-use-v1',
      data: { version: 1, phase: 'authentication_required' }
    }
  ]
  const encode = (value: unknown[]) => value.map(entry => JSON.stringify(entry)).join('\n') + '\n'
  const sdk = async () => ({
    CURRENT_SESSION_VERSION: 3,
    parseSessionEntries: (content: string) =>
      content
        .trim()
        .split('\n')
        .map(line => JSON.parse(line)),
    buildSessionContext: () => ({ model: null }),
    resolveCliModel() {
      throw new Error('A pending first-use restore must not resolve a model')
    },
    ModelRuntime: {
      create: async () => {
        throw new Error('A pending first-use restore must not open a model runtime')
      }
    }
  })
  try {
    writeFileSync(sessionFile, encode(records))
    const source = await prepareRestoreSource(identity, sdk as any)
    assert.equal(source.model, null)
    assert.equal(source.leafId, 'pending')
    assert.deepEqual(source.nativeFirstUse, { version: 1, phase: 'authentication_required' })
    source.assertUnchanged()

    writeFileSync(
      sessionFile,
      encode([records[0], { ...records[1], data: { version: 1, phase: 'ready', provider: 'native' } }])
    )
    await assert.rejects(prepareRestoreSource(identity, sdk as any), PiModelRestoreMismatchError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

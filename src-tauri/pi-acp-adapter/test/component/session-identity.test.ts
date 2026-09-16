import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { getPiAcpSessionMapPath } from '../../src/acp/paths.js'
import { getPiSessionsDir } from '../../src/acp/pi-sessions.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { assertSessionFile, readNativeIdentity, nativeSessionDescriptor } from '../../src/acp/session-identity.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { sessionFixture } from '../helpers/session-fixture.js'

const cwd = process.cwd()
const negotiated = {
  protocolVersion: 1,
  clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
}

function fixture() {
  const sessionFile = sessionFixture('native', cwd)
  const store = new SessionStore(join(dirname(sessionFile), 'map.json'))
  store.upsert({ sessionId: 'native', cwd, sessionFile })
  const conn = asAgentConn(new FakeAgentSideConnection())
  const agent = new PiAcpAgent(conn)
  Object.assign(agent, { store })
  return { agent, store, conn, sessionFile }
}

function nativeProcess(sessionFile: string, sessionId = 'native') {
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({ sessionId, sessionFile, thinkingLevel: 'medium' })
  Object.assign(proc, { getMessages: async () => ({ messages: [] }), getAvailableModels: async () => ({ models: [] }) })
  return proc
}

test('native identity is required; missing state cannot fabricate a session ID', () => {
  for (const state of [
    null,
    {},
    { sessionId: 'x' },
    { sessionId: '', sessionFile: '/x' },
    { sessionId: 'x', sessionFile: 'relative' }
  ]) {
    assert.throws(() => readNativeIdentity(state))
  }
})

test('session descriptor is native and cannot silently change the bound file or identity', () => {
  const expected = { sessionId: 'native', sessionFile: '/fixture/not-yet-flushed.jsonl', cwd }
  assert.deepEqual(nativeSessionDescriptor(expected, expected), { version: 1, ...expected })
  for (const state of [{ ...expected, sessionId: 'other' }, { ...expected, sessionFile: '/fixture/other.jsonl' }, {}]) {
    assert.throws(() => nativeSessionDescriptor(state, expected))
  }
})

test('missing, empty and mismatched native files are rejected before spawning Pi', async t => {
  for (const mutation of ['missing', 'empty', 'id', 'cwd']) {
    const f = fixture()
    await f.agent.initialize(negotiated)
    if (mutation === 'missing') rmSync(f.sessionFile)
    else
      writeFileSync(
        f.sessionFile,
        mutation === 'empty'
          ? ''
          : JSON.stringify({
              type: 'session',
              id: mutation === 'id' ? 'other' : 'native',
              cwd: mutation === 'cwd' ? '/other' : cwd
            })
      )
    const spawn = t.mock.method(PiRpcProcess, 'spawn', async () => {
      throw new Error('must not spawn')
    })
    await assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] }), { code: -32602 })
    assert.equal(spawn.mock.callCount(), 0)
    assert.ok(f.store.get('native'))
    spawn.mock.restore()
  }
})

test('restore checks the actual native ID and file, closes mismatch, and preserves the binding', async t => {
  for (const mismatch of ['id', 'file']) {
    const f = fixture()
    await f.agent.initialize(negotiated)
    const proc = nativeProcess(
      mismatch === 'file' ? sessionFixture('native', cwd) : f.sessionFile,
      mismatch === 'id' ? 'other' : 'native'
    )
    const dispose = t.mock.method(proc, 'dispose')
    const spawn = t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
    await assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] }), { code: -32603 })
    assert.equal(dispose.mock.callCount(), 1)
    assert.equal(f.store.get('native')?.sessionFile, f.sessionFile)
    spawn.mock.restore()
  }
})

test('a valid load reuses idle process; wrong cwd and busy replay cannot tear it down', async t => {
  const f = fixture()
  const proc = nativeProcess(f.sessionFile)
  const dispose = t.mock.method(proc, 'dispose')
  const spawn = t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
  await f.agent.initialize(negotiated)
  const loaded = await f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] })
  assert.deepEqual((loaded._meta?.farfoldPi as { nativeSession: unknown }).nativeSession, {
    version: 1,
    sessionId: 'native',
    sessionFile: f.sessionFile,
    cwd
  })
  await f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] })
  await assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd: '/other', mcpServers: [] }), { code: -32602 })
  const prompt = f.agent.prompt({ sessionId: 'native', prompt: [{ type: 'text', text: 'work' }] })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] }), { code: -32600 })
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } })
  proc.emit({ type: 'agent_settled' })
  assert.equal((await prompt).stopReason, 'end_turn')
  assert.equal(spawn.mock.callCount(), 1)
  assert.equal(dispose.mock.callCount(), 0)
  f.agent.dispose()
})

test('concurrent restore keeps one process and rejects duplicate replay', async t => {
  const f = fixture()
  const proc = nativeProcess(f.sessionFile)
  let release!: () => void
  const started = new Promise<void>(resolve => {
    release = resolve
  })
  const spawn = t.mock.method(PiRpcProcess, 'spawn', async () => {
    await started
    return proc as unknown as PiRpcProcess
  })
  await f.agent.initialize(negotiated)
  const first = f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] })
  const second = assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] }), { code: -32600 })
  release()
  await first
  await second
  assert.equal(spawn.mock.callCount(), 1)
  f.agent.dispose()
})

test('identity changed during history replay closes the process without changing its saved binding', async t => {
  const f = fixture()
  const proc = nativeProcess(f.sessionFile)
  const dispose = t.mock.method(proc, 'dispose')
  proc.getMessages = async () => {
    proc.getState = async () => ({ sessionId: 'other', sessionFile: f.sessionFile, thinkingLevel: 'medium' })
    return { messages: [] }
  }
  t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
  await f.agent.initialize(negotiated)
  await assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] }), { code: -32603 })
  assert.equal(dispose.mock.callCount(), 1)
  assert.equal(f.store.get('native')?.sessionFile, f.sessionFile)
})

test('a prompt cannot enter while native history is loading, including the reverse ordering', async t => {
  const f = fixture()
  const proc = nativeProcess(f.sessionFile)
  let release!: () => void
  const loading = new Promise<void>(resolve => {
    release = resolve
  })
  Object.assign(proc, {
    getMessages: async () => {
      await loading
      return { messages: [] }
    }
  })
  t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
  await f.agent.initialize(negotiated)
  const load = f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] })
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.agent.prompt({ sessionId: 'native', prompt: [{ type: 'text', text: 'must not send' }] }), {
    code: -32600
  })
  await assert.rejects(f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] }), { code: -32600 })
  assert.equal(proc.prompts.length, 0)
  release()
  await load
  const prompt = f.agent.prompt({ sessionId: 'native', prompt: [{ type: 'text', text: 'after load' }] })
  await new Promise(resolve => setImmediate(resolve))
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } })
  proc.emit({ type: 'agent_settled' })
  await prompt
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['after load']
  )
  f.agent.dispose()
})

test('prompt restoring first cannot send after a competing replay acquires the session', async t => {
  const f = fixture()
  const proc = nativeProcess(f.sessionFile)
  let release!: () => void
  const starting = new Promise<void>(resolve => {
    release = resolve
  })
  t.mock.method(PiRpcProcess, 'spawn', async () => {
    await starting
    return proc as unknown as PiRpcProcess
  })
  await f.agent.initialize(negotiated)
  const prompt = assert.rejects(
    f.agent.prompt({ sessionId: 'native', prompt: [{ type: 'text', text: 'not yet bound' }] }),
    { code: -32600 }
  )
  const load = f.agent.loadSession({ sessionId: 'native', cwd, mcpServers: [] })
  release()
  await prompt
  await load
  assert.equal(proc.prompts.length, 0)
  f.agent.dispose()
})

test('create rejects missing native identity and disposes only its unbound process', async t => {
  const proc = new FakePiRpcProcess()
  proc.getState = async () => ({})
  const dispose = t.mock.method(proc, 'dispose')
  t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
  const manager = new SessionManager()
  await assert.rejects(manager.create({ cwd, mcpServers: [], conn: asAgentConn(new FakeAgentSideConnection()) }), {
    code: -32603
  })
  assert.equal(dispose.mock.callCount(), 1)
})

test('creating a second native session preserves the first process and rejects duplicate identity', async t => {
  const f = fixture()
  const proc1 = nativeProcess(f.sessionFile)
  const proc2 = nativeProcess(sessionFixture('second', cwd), 'second')
  const duplicate = nativeProcess(f.sessionFile)
  const dispose1 = t.mock.method(proc1, 'dispose')
  const disposeDuplicate = t.mock.method(duplicate, 'dispose')
  const queue = [proc1, proc2, duplicate]
  t.mock.method(PiRpcProcess, 'spawn', async () => queue.shift() as unknown as PiRpcProcess)
  const manager = new SessionManager()
  Object.assign(manager, { store: f.store })
  const params = { cwd, mcpServers: [], conn: f.conn }
  await manager.create(params)
  await manager.create(params)
  await assert.rejects(manager.create(params), { code: -32603 })
  assert.ok(manager.maybeGet('native'))
  assert.ok(manager.maybeGet('second'))
  assert.equal(dispose1.mock.callCount(), 0)
  assert.equal(disposeDuplicate.mock.callCount(), 1)
  manager.disposeAll()
})

test('profile-local references and explicit native session directory stay isolated', () => {
  const originalAgent = process.env.PI_CODING_AGENT_DIR
  const originalSessions = process.env.PI_CODING_AGENT_SESSION_DIR
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-profiles-'))
  try {
    process.env.PI_CODING_AGENT_DIR = join(root, 'a')
    const a = new SessionStore()
    a.upsert({ sessionId: 'native', cwd, sessionFile: sessionFixture('native', cwd) })
    const mapA = getPiAcpSessionMapPath()
    process.env.PI_CODING_AGENT_DIR = join(root, 'b')
    assert.notEqual(getPiAcpSessionMapPath(), mapA)
    assert.equal(new SessionStore().get('native'), null)
    assert.ok(a.get('native'))
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'explicit-sessions')
    assert.equal(getPiSessionsDir(), join(root, 'explicit-sessions'))
  } finally {
    if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = originalAgent
    if (originalSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessions
  }
})

test('corrupt reference map fails closed without overwriting evidence', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pi-acp-map-')), 'map.json')
  const store = new SessionStore(file)
  for (const content of ['{', '{"version":1,"sessions":[]}', '{"version":1,"sessions":{"x":{"sessionId":"other"}}}']) {
    writeFileSync(file, content)
    assert.throws(() => store.get('x'), /corrupt/)
    assert.throws(() => store.upsert({ sessionId: 'new', cwd, sessionFile: '/native' }), /corrupt/)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('bounded file header validation rejects oversized headers', () => {
  const file = sessionFixture('native', cwd)
  writeFileSync(file, ' '.repeat(65 * 1024))
  assert.throws(() => assertSessionFile({ sessionId: 'native', cwd, sessionFile: file }))
})

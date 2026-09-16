import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess, PiModelRestoreMismatchError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { sessionFixture } from '../helpers/session-fixture.js'

class FakeSessions {
  restoredSession: any = null

  constructor(private readonly buildSession: (sessionId: string, params: any) => any) {}

  maybeGet(sessionId: string) {
    return this.restoredSession?.sessionId === sessionId ? this.restoredSession : undefined
  }

  getOrCreate(sessionId: string, params: any) {
    if (!this.restoredSession) {
      this.restoredSession = this.buildSession(sessionId, params)
    }
    return this.restoredSession
  }
}

test('managed pre-file receipt restores the exact empty identity and bootstrap model without manufacturing history', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pi-managed-pre-file-'))
  const sessionFile = join(root, 'sessions', 'original.jsonl')
  mkdirSync(join(root, 'sessions'))
  mkdirSync(join(root, 'agent'), { mode: 0o700 })
  const anchor = { version: 1, binding: 'a'.repeat(64), provider: 'managed-test', modelId: 'test-model' }
  const env = process.env.FARFOLD_PI_MANAGED_PRE_FILE
  const dir = process.env.PI_CODING_AGENT_DIR
  process.env.FARFOLD_PI_MANAGED_PRE_FILE = JSON.stringify(anchor)
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
  const originalSpawn = PiRpcProcess.spawn
  const calls: any[] = []
  const state = {
    sessionId: 'managed-empty',
    sessionFile,
    model: { provider: anchor.provider, id: anchor.modelId },
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0
  }
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    calls.push(params)
    return {
      getState: async () => state,
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [state.model] }),
      onEvent: () => () => {},
      dispose: () => {}
    }
  }
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
    })
    const entry = { sessionId: state.sessionId, cwd: root, sessionFile, managedPreFile: anchor }
    ;(agent as any).store = { get: () => entry, upsert: () => {} }
    ;(agent as any).sessions = new FakeSessions((sessionId, params) => ({
      sessionId,
      cwd: params.cwd,
      proc: params.proc
    }))
    const restored = await (agent as any).restoreSession(state.sessionId, { cwd: root })
    assert.equal(restored.sessionId, state.sessionId)
    assert.deepEqual(calls[0].preFileModel, { provider: anchor.provider, modelId: anchor.modelId })
    assert.equal(calls[0].sessionId, state.sessionId)
    assert.equal(calls[0].sessionPath, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (env === undefined) delete process.env.FARFOLD_PI_MANAGED_PRE_FILE
    else process.env.FARFOLD_PI_MANAGED_PRE_FILE = env
    if (dir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = dir
    rmSync(root, { recursive: true, force: true })
  }
})

test('cold model mismatch closes the attempted process without replacing history, binding or executing a prompt', async () => {
  const originalSpawn = PiRpcProcess.spawn
  for (const reason of ['model_mismatch', 'parser_unavailable', 'history_unavailable'] as const) {
    const sessionFile = sessionFixture('original-native', '/tmp/original-project')
    const original = readFileSync(sessionFile)
    let disposed = 0
    let observed = 0
    let created = 0
    const upserts: unknown[] = []
    ;(PiRpcProcess as any).spawn = async () => ({
      getState: async () => ({ sessionId: 'original-native', sessionFile }),
      verifyRestoredModel: async () => {
        observed++
        throw new PiModelRestoreMismatchError(reason)
      },
      dispose: () => {
        disposed++
      }
    })
    try {
      const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
      })
      ;(agent as any).sessions = {
        maybeGet: () => undefined,
        getOrCreate: () => {
          created++
          throw new Error('Must not create fallback session')
        }
      }
      ;(agent as any).store = {
        get: () => ({ sessionId: 'original-native', cwd: '/tmp/original-project', sessionFile }),
        upsert: (value: unknown) => upserts.push(value)
      }
      await assert.rejects(
        agent.prompt({
          sessionId: 'original-native',
          prompt: [{ type: 'text', text: 'Do not run with a fallback model' }]
        }),
        error => {
          assert.equal((error as { code?: number }).code, -32600)
          assert.deepEqual((error as { data?: unknown }).data, { farfoldPiRestoreBlocked: true, reason })
          return true
        }
      )
      assert.equal(observed, 1)
      assert.equal(disposed, 1)
      assert.equal(created, 0)
      assert.deepEqual(upserts, [])
      assert.deepEqual(readFileSync(sessionFile), original)
    } finally {
      PiRpcProcess.spawn = originalSpawn
      rmSync(dirname(sessionFile), { recursive: true, force: true })
    }
  }
})

test('PiAcpAgent: prompt auto-restores a missing session from SessionStore', async () => {
  const sessionFile = sessionFixture('stored-session', '/tmp/store-project')
  const conn = new FakeAgentSideConnection()
  const promptCalls: Array<{ message: string; images: unknown[] }> = []
  const spawnCalls: any[] = []
  const storeUpserts: any[] = []

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    async prompt(message: string, images: unknown[]) {
      promptCalls.push({ message, images })
      return 'end_turn'
    },
    async cancel() {},
    wasCancelRequested() {
      return false
    }
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      getState: async () => ({ sessionId: 'stored-session', sessionFile }),
      verifyRestoredModel: async () => {},
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
    })
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get(sessionId: string) {
        if (sessionId !== 'stored-session') return null
        return {
          sessionId,
          cwd: '/tmp/store-project',
          sessionFile,
          updatedAt: new Date().toISOString()
        }
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'hello again' }]
    } as any)

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/store-project',
        sessionPath: sessionFile,
        sessionId: 'stored-session',
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(promptCalls, [{ message: 'hello again', images: [] }])
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'stored-session',
        cwd: '/tmp/store-project',
        sessionFile
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: setSessionConfigOption auto-restores via pi session discovery when SessionStore misses', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-restore-fallback-'))
  const sessionsDir = join(root, 'sessions', '--tmp--fallback-project--')
  const sessionFile = join(sessionsDir, '0000_restore_fallback.jsonl')
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'fallback-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      cwd: '/tmp/fallback-project'
    }) + '\n',
    'utf-8'
  )

  process.env.PI_CODING_AGENT_DIR = root

  const storeUpserts: any[] = []
  const setModelCalls: Array<{ provider: string; modelId: string }> = []
  const spawnCalls: any[] = []
  const state = {
    sessionId: 'fallback-session',
    sessionFile,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      getAvailableModels: async () => ({
        models: [
          { provider: 'test', id: 'alpha', name: 'Alpha' },
          { provider: 'test', id: 'beta', name: 'Beta' }
        ]
      }),
      getAvailableThinkingLevels: async () => ({ levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }),
      getState: async () => state,
      verifyRestoredModel: async () => {},
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
    })
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get() {
        return null
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.setSessionConfigOption({
      sessionId: 'fallback-session',
      configId: 'model',
      value: 'test/beta'
    } as any)

    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/fallback-project',
        sessionPath: sessionFile,
        sessionId: 'fallback-session',
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
    assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      },
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      }
    ])
    assert.deepEqual(conn.updates, [
      {
        sessionId: 'fallback-session',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: result.configOptions
        }
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: cancel ignores stale session IDs without spawning a restore process', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
    })
    ;(agent as any).sessions = new FakeSessions(() => {
      throw new Error('cancel should not restore a missing session')
    }) as any

    await agent.cancel({ sessionId: 'stale-session' } as any)

    assert.deepEqual(spawnCalls, [])
    assert.deepEqual(conn.updates, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

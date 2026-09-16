import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: any) {}

  async create(_params: any) {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('PiAcpAgent: newSession throws AUTH_REQUIRED when pi reports zero available models', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
  })
  ;(agent as any).sessions = sessions as any

  let threw = false
  try {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  } catch (e: any) {
    threw = true
    assert.equal(e?.code, -32000)
    assert.match(String(e?.message), /Configure an API key or log in with an OAuth provider/i)
  }

  assert.equal(threw, true)
  assert.deepEqual(sessions.closeCalls, ['s1'])
})

test('explicit unauthenticated new session keeps its native identity but cannot prompt before confirmed model selection', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-empty-owned-')))
  const previous = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  class EmptyProcess extends FakePiRpcProcess {
    available = false
    selected = false
    wrong = false
    firstUse: unknown[] = []
    override async getAvailableModels() {
      return { models: this.available ? [{ provider: 'native', id: 'model' }] : [] }
    }
    override async getState() {
      return {
        sessionId: 'empty-native',
        sessionFile: '/private/empty-native.jsonl',
        model: this.selected ? { provider: 'native', id: this.wrong ? 'wrong' : 'model' } : null,
        thinkingLevel: 'off',
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0
      }
    }
    async setModel() {
      this.selected = true
    }
    async recordNativeFirstUse(state: unknown) {
      this.firstUse.push(state)
    }
  }
  const proc = new EmptyProcess()
  const session = {
    sessionId: 'empty-native',
    cwd: process.cwd(),
    isUsable: true,
    proc,
    setStartupInfo() {},
    async sendStartupInfoIfPending() {}
  }
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const sessions = new FakeSessions(session)
  Object.defineProperty(agent, 'sessions', {
    value: {
      create: () => sessions.create({}),
      close: (id: string) => sessions.close(id),
      maybeGet: (id: string) => (id === session.sessionId ? session : undefined)
    }
  })
  Object.defineProperty(agent, 'store', {
    value: {
      get: () => ({ cwd: process.cwd(), sessionFile: '/private/empty-native.jsonl' }),
      setNativeFirstUse() {}
    }
  })
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
  })
  const opened = await agent.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    _meta: { farfoldPi: { allowUnauthenticated: true } }
  })
  assert.equal(opened.sessionId, 'empty-native')
  assert.equal(opened._meta.farfoldPi.modelSelectionRequired, true)
  assert.deepEqual(opened._meta.farfoldPi.nativeFirstUse, {
    version: 1,
    phase: 'authentication_required'
  })
  assert.equal(opened.models, null)
  assert.equal(
    opened.configOptions.some(option => option.id === 'model'),
    false
  )
  assert.deepEqual(sessions.closeCalls, [])
  const prompt = () => agent.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Must not send' }] })
  await assert.rejects(prompt(), { code: -32600 })
  proc.available = true
  // An authentication/catalog refresh is not a model choice.
  await agent.extMethod('_pi/workspace', { sessionId: session.sessionId, section: 'configuration' })
  await assert.rejects(prompt(), { code: -32600 })
  proc.wrong = true
  await assert.rejects(
    agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'model', value: 'native/model' }),
    { code: -32600 }
  )
  await assert.rejects(prompt(), { code: -32600 })
  proc.wrong = false
  const configured = await agent.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: 'model',
    value: 'native/model'
  })
  assert.equal(configured.configOptions.find(option => option.id === 'model')?.currentValue, 'native/model')
  assert.deepEqual((configured._meta?.farfoldPi as any)?.nativeFirstUse, {
    version: 1,
    phase: 'ready',
    provider: 'native',
    modelId: 'model'
  })
  assert.deepEqual(proc.firstUse, [
    { version: 1, phase: 'authentication_required' },
    { version: 1, phase: 'ready', provider: 'native', modelId: 'model' }
  ])
  assert.deepEqual(proc.prompts, [])
})

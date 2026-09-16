import assert from 'node:assert/strict'
import test from 'node:test'
import type { CreateElicitationResponse } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcRejectedError, PiRpcProcess, PiPromptNotSentError, type PiPromptModel } from '../../src/pi-rpc/process.js'
import { FakePiRpcProcess, FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const initialize = {
  protocolVersion: 1,
  clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
}

function fixture(proc = new FakePiRpcProcess()) {
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 'native',
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as unknown as PiRpcProcess
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.defineProperty(agent, 'sessions', {
    value: { maybeGet: (id: string) => (id === 'native' ? session : undefined) }
  })
  return { agent, session, proc, conn }
}

test('unnegotiated or wrong-version Pi clients cannot start a session or send intervention', async () => {
  const f = fixture()
  await assert.rejects(f.agent.newSession({ cwd: process.cwd(), mcpServers: [] }), { code: -32600 })
  await f.agent.initialize({
    ...initialize,
    clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 2 } } }
  })
  await assert.rejects(f.agent.extMethod('_pi/steer', { sessionId: 'native', message: 'No' }), { code: -32600 })
  assert.deepEqual(f.proc.interventions, [])
})

test('Host prompt model expectation reaches native dispatch and a preflight failure stays explicitly not sent', async () => {
  class PreflightProcess extends FakePiRpcProcess {
    expected?: PiPromptModel
    override async prompt(_message: string, _images: unknown[] = [], expectedModel?: PiPromptModel) {
      this.expected = expectedModel
      throw new PiPromptNotSentError('private native detail must not escape')
    }
  }
  const proc = new PreflightProcess()
  const f = fixture(proc)
  const initialized = await f.agent.initialize(initialize)
  assert.equal((initialized.agentCapabilities?._meta?.farfoldPi as Record<string, unknown>).promptModel, true)
  const expectedModel = {
    version: 1,
    sessionId: 'native',
    sessionFile: '/private/native.jsonl',
    provider: 'provider',
    modelId: 'model'
  }
  await assert.rejects(
    f.agent.prompt({
      sessionId: 'native',
      prompt: [{ type: 'text', text: 'Original task' }],
      _meta: { farfoldPi: { hostTurnId: 'host-turn', expectedModel } }
    }),
    error => {
      assert.equal((error as { code?: number }).code, -32600)
      assert.deepEqual((error as { data?: unknown }).data, { farfoldPiPromptNotSent: true })
      assert.equal(String(error).includes('private native detail'), false)
      return true
    }
  )
  const { version: _version, ...expected } = expectedModel
  assert.deepEqual(proc.expected, expected)
  assert.equal(f.session.hasActiveTurn, false)
  assert.equal(f.session.isUsable, true)
  assert.deepEqual(proc.prompts, [])
  await assert.rejects(
    f.agent.prompt({
      sessionId: 'native',
      prompt: [{ type: 'text', text: 'No unbound model claim' }],
      _meta: { farfoldPi: { expectedModel } }
    }),
    { code: -32600 }
  )
})

test('workspace reads preserve native entries and reject state identity drift or arbitrary commands', async () => {
  class WorkspaceProcess extends FakePiRpcProcess {
    sessionId = 'native'
    override async getState() {
      return {
        sessionId: this.sessionId,
        sessionFile: '/private/pi/native.jsonl',
        thinkingLevel: 'medium',
        futureState: 7
      }
    }
    async getEntries() {
      return { entries: [{ id: 'entry', type: 'custom', data: { future: true } }], leafId: 'entry' }
    }
    async getSessionStats() {
      return { inputTokens: 17 }
    }
  }
  const proc = new WorkspaceProcess()
  const f = fixture(proc)
  Object.defineProperty(f.agent, 'store', {
    value: { get: () => ({ cwd: process.cwd(), sessionFile: '/private/pi/native.jsonl' }) }
  })
  await assert.rejects(f.agent.extMethod('_pi/workspace', { sessionId: 'native' }))
  await f.agent.initialize(initialize)
  const result = await f.agent.extMethod('_pi/workspace', { sessionId: 'native', section: 'entries' })
  assert.equal(result.version, 1)
  assert.deepEqual(result.data, await proc.getEntries())
  const state = await f.agent.extMethod('_pi/workspace', { sessionId: 'native', section: 'state' })
  assert.deepEqual(state.data, await proc.getState())
  const count = f.conn.updates.length
  await f.agent.extMethod('_pi/workspace', { sessionId: 'native', section: 'session_command' })
  const output = f.conn.updates[count]
  assert.equal(output.sessionId, 'native')
  assert.equal(output.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((output.update._meta?.farfoldPi as any)?.origin, 'adapter_control')
  assert.equal((output.update._meta?.farfoldPi as any)?.version, 1)
  assert.equal(typeof (output.update._meta?.farfoldPi as any)?.id, 'string')
  await assert.rejects(f.agent.extMethod('_pi/workspace', { sessionId: 'native', section: 'prompt' }))
  await assert.rejects(f.agent.extMethod('_pi/workspace', { sessionId: 'native', command: 'prompt' }))
  await assert.rejects(f.agent.extMethod('_pi/workspace', { sessionId: 'other' }))
  proc.sessionId = 'changed'
  await assert.rejects(
    f.agent.extMethod('_pi/workspace', { sessionId: 'native', section: 'entries' }),
    /changed its bound native session identity/
  )
  assert.deepEqual(proc.prompts, [])
})

test('native event feed preserves unknown envelopes with session identity without replacing ACP updates', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 'native',
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: proc as unknown as PiRpcProcess,
    nativeEvents: true
  })
  const unknown = { type: 'future_pi_event', fields: { identity: 'keep', nested: [false, ''] } }
  proc.emit(unknown)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(conn.notifications[0], {
    method: '_pi/event',
    params: { version: 1, sessionId: 'native', event: unknown }
  })
  assert.equal(conn.notifications.length, 2)
  assert.equal(conn.updates[0]?.update.sessionUpdate, 'agent_message_chunk')
})

test('profile refresh is negotiated, bound, idle-only and never fabricates a successful unknown result', async () => {
  class ProfileProcess extends FakePiRpcProcess {
    calls = 0
    fail = false
    isRefreshingProfile = false
    override async getState() {
      return { sessionId: 'native', sessionFile: '/private/pi/native.jsonl' }
    }
    async refreshProfile() {
      this.calls++
      if (this.fail) throw new Error('private credential detail')
    }
  }
  const proc = new ProfileProcess()
  const f = fixture(proc)
  Object.defineProperty(f.agent, 'store', {
    value: { get: () => ({ cwd: process.cwd(), sessionFile: '/private/pi/native.jsonl' }) }
  })
  await assert.rejects(f.agent.extMethod('_pi/refresh_profile', { sessionId: 'native' }), { code: -32600 })
  await f.agent.initialize(initialize)
  await assert.rejects(f.agent.extMethod('_pi/refresh_profile', { sessionId: 'other' }))
  await assert.rejects(f.agent.extMethod('_pi/refresh_profile', { sessionId: 'native', command: '/other' }))
  const turn = f.session.prompt('Work')
  await assert.rejects(f.agent.extMethod('_pi/refresh_profile', { sessionId: 'native' }), { code: -32600 })
  assert.equal(proc.calls, 0)
  await f.session.cancel()
  proc.emit({ type: 'agent_settled' })
  await turn
  let answer!: (response: CreateElicitationResponse) => void
  f.conn.unstable_createElicitation = () =>
    new Promise(resolve => {
      answer = resolve
    })
  proc.emit({ type: 'extension_ui_request', id: 'idle-dialog', method: 'confirm', title: 'Native idle extension' })
  await new Promise(resolve => setImmediate(resolve))
  const whileDialog = await f.agent.extMethod('_pi/refresh_profile', { sessionId: 'native' }).then(
    () => null,
    error => error
  )
  answer({ action: 'accept', content: { value: true } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(whileDialog?.code, -32600)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'idle-dialog', confirmed: true }])
  assert.equal(proc.calls, 0)
  proc.isRefreshingProfile = true
  await assert.rejects(f.agent.prompt({ sessionId: 'native', prompt: [{ type: 'text', text: '/model' }] }), {
    code: -32600
  })
  proc.isRefreshingProfile = false
  const refreshed = await f.agent.extMethod('_pi/refresh_profile', { sessionId: 'native' })
  assert.equal(refreshed.version, 1)
  assert.equal(proc.calls, 1)
  proc.fail = true
  await assert.rejects(f.agent.extMethod('_pi/refresh_profile', { sessionId: 'native' }), error => {
    const result = error as { message: string; data?: { farfoldOutcomeUnknown?: boolean } }
    assert.equal(result.message.includes('private'), false)
    assert.equal(result.data?.farfoldOutcomeUnknown, true)
    return true
  })
})

test('steer and follow_up dispatch exact native methods, not queued ordinary prompts', async () => {
  const f = fixture()
  await f.agent.initialize(initialize)
  await assert.rejects(f.agent.extMethod('_pi/steer', { sessionId: 'native', message: 'Idle' }))
  const pending = f.session.prompt('Original')
  for (const type of ['steer', 'follow_up']) {
    const result = await f.agent.extMethod(`_pi/${type}`, { sessionId: 'native', message: type })
    assert.equal(result.accepted, true)
  }
  assert.deepEqual(f.proc.interventions, [
    { type: 'steer', message: 'steer' },
    { type: 'follow_up', message: 'follow_up' }
  ])
  assert.deepEqual(
    f.proc.prompts.map(prompt => prompt.message),
    ['Original']
  )
  await assert.rejects(f.agent.extMethod('_pi/steer', { sessionId: 'other', message: 'Wrong' }))
  await f.session.cancel()
  await assert.rejects(f.agent.extMethod('_pi/follow_up', { sessionId: 'native', message: 'After cancel' }))
  f.proc.emit({ type: 'agent_settled' })
  assert.equal(await pending, 'cancelled')
})

test('native intervention requires a boolean success acknowledgement', async () => {
  for (const success of [true, false, undefined, 'false']) {
    const proc = Object.create(PiRpcProcess.prototype) as PiRpcProcess
    const commands: unknown[] = []
    Object.defineProperty(proc, 'request', {
      value: async (command: unknown) => {
        commands.push(command)
        return { success }
      }
    })
    if (success === true) await proc.intervene('steer', 'Update')
    else
      await assert.rejects(proc.intervene('steer', 'Update'), error => {
        assert.equal(error instanceof PiRpcRejectedError, success === false)
        return true
      })
    assert.deepEqual(commands, [{ type: 'steer', message: 'Update' }])
  }
})

test('intervention distinguishes explicit rejection from an unknown native acknowledgement', async () => {
  for (const explicit of [true, false]) {
    class FailingProcess extends FakePiRpcProcess {
      override async intervene(): Promise<void> {
        if (explicit) throw new PiRpcRejectedError('private native error')
        throw new Error('private transport error')
      }
    }
    const f = fixture(new FailingProcess())
    await f.agent.initialize(initialize)
    const pending = f.session.prompt('Original')
    await assert.rejects(f.agent.extMethod('_pi/steer', { sessionId: 'native', message: 'Update' }), error => {
      const failure = error as { code: number; data?: { farfoldOutcomeUnknown?: boolean }; message: string }
      assert.equal(failure.code, explicit ? -32600 : -32603)
      assert.equal(failure.data?.farfoldOutcomeUnknown === true, !explicit)
      assert.equal(failure.message.includes('private'), false)
      return true
    })
    assert.equal(f.proc.prompts.length, 1)
    await f.session.cancel()
    f.proc.emit({ type: 'agent_settled' })
    assert.equal(await pending, 'cancelled')
  }
})

test('EOF preserves unknown and cannot be overwritten by a late settled event', async () => {
  const f = fixture()
  const pending = f.session.prompt('Original')
  const rejected = assert.rejects(
    pending,
    error => (error as { data?: { farfoldOutcomeUnknown?: boolean } }).data?.farfoldOutcomeUnknown === true
  )
  f.proc.emit({ type: 'pi_acp_transport_closed' })
  f.proc.emit({ type: 'agent_settled' })
  await rejected
  await assert.rejects(f.session.prompt('No automatic restart'))
  assert.equal(f.proc.prompts.length, 1)
})

test('pure extension command settles only with native command identity and strict idle state', async () => {
  class ExtensionProcess extends FakePiRpcProcess {
    override async getCommands() {
      return { commands: [{ name: 'inspect', source: 'extension' }] }
    }
    override async getState() {
      return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
    }
  }
  const f = fixture(new ExtensionProcess())
  assert.equal(await f.session.prompt('/inspect'), 'end_turn')
  assert.equal(f.proc.prompts.length, 1)
})

test('extension that starts the Agent must still wait for agent_settled', async () => {
  class ActiveExtensionProcess extends FakePiRpcProcess {
    override async getCommands() {
      return { commands: [{ name: 'inspect', source: 'extension' }] }
    }
    override async getState() {
      return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
    }
    override async prompt(message: string) {
      await super.prompt(message)
      this.emit({ type: 'agent_start' })
    }
  }
  const f = fixture(new ActiveExtensionProcess())
  let finished = false
  const pending = f.session.prompt('/inspect').then(reason => {
    finished = true
    return reason
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  f.proc.emit({ type: 'agent_end' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  f.proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  f.proc.emit({ type: 'agent_settled' })
  assert.equal(await pending, 'end_turn')
})

test('unsupported thinking options are rejected before changing the native model', async () => {
  class NonReasoningProcess extends FakePiRpcProcess {
    constructor() {
      super()
      this.thinkingLevel = 'off'
    }
    override async getAvailableThinkingLevels() {
      return { levels: ['off'] }
    }
  }
  const f = fixture(new NonReasoningProcess())
  await f.agent.initialize(initialize)
  await assert.rejects(f.agent.setSessionMode({ sessionId: 'native', modeId: 'high' }), { code: -32602 })
  assert.equal(f.proc.thinkingLevel, 'off')
  const result = await f.agent.setSessionConfigOption({ sessionId: 'native', configId: 'thought_level', value: 'off' })
  const option = result.configOptions.find(option => option.id === 'thought_level')
  assert.equal(option?.type, 'select')
  assert.deepEqual(
    option?.options.map(option => ('value' in option ? option.value : null)),
    ['off']
  )
})

test('native model error reaches ACP as explicit failure, not end_turn', async () => {
  const f = fixture()
  await f.agent.initialize(initialize)
  const pending = f.agent.prompt({ sessionId: 'native', prompt: [{ type: 'text', text: 'Work' }] })
  const rejected = assert.rejects(pending, error => {
    const data = (error as { data?: { farfoldOutcomeUnknown?: boolean; nativeStopReason?: string } }).data
    return data?.farfoldOutcomeUnknown === false && data?.nativeStopReason === 'error'
  })
  await new Promise(resolve => setImmediate(resolve))
  f.proc.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'private provider detail' }
  })
  f.proc.emit({ type: 'agent_settled' })
  await rejected
})

test('fixed native max thinking is preserved without accepting unknown levels', async () => {
  class MaxThinkingProcess extends FakePiRpcProcess {
    override async getAvailableThinkingLevels() {
      return { levels: ['minimal', 'medium', 'max'] }
    }
  }
  const f = fixture(new MaxThinkingProcess())
  await f.agent.initialize(initialize)
  const result = await f.agent.setSessionConfigOption({ sessionId: 'native', configId: 'thought_level', value: 'max' })
  assert.equal(f.proc.thinkingLevel, 'max')
  const option = result.configOptions.find(option => option.id === 'thought_level')
  assert.equal(option?.currentValue, 'max')
  assert.deepEqual(
    option?.options.map(option => ('value' in option ? option.value : null)),
    ['minimal', 'medium', 'max']
  )
  await assert.rejects(f.agent.setSessionMode({ sessionId: 'native', modeId: 'future' }), { code: -32602 })
  assert.equal(f.proc.thinkingLevel, 'max')
  assert.deepEqual(f.proc.prompts, [])
})

test('native retry success replaces failure without leaking the first error', async () => {
  const f = fixture()
  const pending = f.session.prompt('Work')
  f.proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } })
  f.proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1 })
  f.proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  f.proc.emit({ type: 'agent_settled' })
  assert.equal(await pending, 'end_turn')
})

test('prompt Provider evidence is per Host turn, follows native retry and never leaks into a built-in command', async () => {
  const f = fixture()
  await f.agent.initialize(initialize)
  for (const [hostTurnId, stopReason] of [
    ['host-one', 'stop'],
    ['host-two', 'error']
  ]) {
    const pending = f.agent
      .prompt({ sessionId: 'native', prompt: [{ type: 'text', text: 'Work' }], _meta: { farfoldPi: { hostTurnId } } })
      .then(
        value => ({ value }),
        error => ({ error })
      )
    await new Promise(resolve => setImmediate(resolve))
    f.proc.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'previous-retry-provider',
        model: 'previous-model',
        stopReason: 'error',
        timestamp: Date.now()
      }
    })
    f.proc.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'current-provider',
        model: 'current-model',
        stopReason,
        timestamp: Date.now(),
        errorMessage: 'private',
        content: [{ text: 'private' }]
      }
    })
    f.proc.emit({ type: 'agent_settled' })
    const result = await pending
    const receipt =
      'error' in result ? result.error.data.farfoldPiProviderRequest : result.value._meta?.farfoldPiProviderRequest
    assert.equal(receipt.hostTurnId, hostTurnId)
    assert.equal(receipt.runtimeProviderId, 'current-provider')
    assert.equal(receipt.runtimeModelId, 'current-provider/current-model')
    assert.equal(receipt.nativeModelId, 'current-model')
    assert.equal(receipt.nativeStopReason, stopReason)
    assert.equal(JSON.stringify(receipt).includes('private'), false)
  }
  const command = await f.agent.prompt({
    sessionId: 'native',
    prompt: [{ type: 'text', text: '/name' }],
    _meta: { farfoldPi: { hostTurnId: 'command-only' } }
  })
  assert.equal(command._meta?.farfoldPiProviderRequest, undefined)
  const incomplete = f.agent.prompt({
    sessionId: 'native',
    prompt: [{ type: 'text', text: 'No provider identity' }],
    _meta: { farfoldPi: { hostTurnId: 'missing' } }
  })
  await new Promise(resolve => setImmediate(resolve))
  f.proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  f.proc.emit({ type: 'agent_settled' })
  assert.equal((await incomplete)._meta?.farfoldPiProviderRequest, undefined)
})

test('failed abort cannot manufacture a confirmed cancelled result', async () => {
  class AbortFailure extends FakePiRpcProcess {
    override async abort(): Promise<void> {
      throw new Error('Native abort rejected')
    }
  }
  const f = fixture(new AbortFailure())
  const pending = f.session.prompt('Work')
  const rejected = assert.rejects(
    pending,
    error => (error as { data?: { farfoldOutcomeUnknown?: boolean } }).data?.farfoldOutcomeUnknown === true
  )
  await assert.rejects(f.session.cancel(), /Native abort rejected/)
  f.proc.emit({ type: 'agent_settled' })
  await rejected
})

test('native terminal waits for the original withdrawn ACP form to settle', async () => {
  const f = fixture()
  let answer!: (value: CreateElicitationResponse) => void
  let withdraw!: () => void
  const withdrawn = new Promise<void>(resolve => {
    withdraw = resolve
  })
  f.conn.unstable_createElicitation = () =>
    new Promise(resolve => {
      answer = resolve
    })
  f.conn.extNotification = async method => {
    if (method === '_pi/ui_withdrawn') withdraw()
  }
  let finished = false
  const pending = f.session.prompt('Work').then(reason => {
    finished = true
    return reason
  })
  f.proc.emit({ type: 'extension_ui_request', id: 'timed', method: 'input', title: 'Timed', timeout: 1 })
  await withdrawn
  f.proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  f.proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setImmediate(resolve))
  const completedBeforeReply = finished
  answer({ action: 'cancel' })
  assert.equal(await pending, 'end_turn')
  assert.equal(completedBeforeReply, false)
  assert.deepEqual(f.proc.extensionUiResponses, [{ id: 'timed', cancelled: true }])
})

test('EOF while draining a form keeps the task unknown and drops a later answer', async () => {
  const f = fixture()
  let answer!: (value: CreateElicitationResponse) => void
  f.conn.unstable_createElicitation = () =>
    new Promise(resolve => {
      answer = resolve
    })
  const pending = f.session.prompt('Work')
  const rejected = assert.rejects(
    pending,
    error => (error as { data?: { farfoldOutcomeUnknown?: boolean } }).data?.farfoldOutcomeUnknown === true
  )
  f.proc.emit({ type: 'extension_ui_request', id: 'old', method: 'input', title: 'Old' })
  f.proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  f.proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setImmediate(resolve))
  f.proc.emit({ type: 'pi_acp_transport_closed' })
  await rejected
  answer({ action: 'accept', content: { value: 'late' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.proc.extensionUiResponses, [])
  assert.equal(f.session.isUsable, false)
})

test('pure extension idle also waits for its final native UI notification', async () => {
  class ExtensionProcess extends FakePiRpcProcess {
    override async getCommands() {
      return { commands: [{ name: 'inspect', source: 'extension' }] }
    }
    override async getState() {
      return { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
    }
    override async prompt(message: string) {
      await super.prompt(message)
      this.emit({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'Done' })
    }
  }
  const f = fixture(new ExtensionProcess())
  let deliver!: () => void
  f.conn.extNotification = () =>
    new Promise(resolve => {
      deliver = resolve
    })
  let finished = false
  const pending = f.session.prompt('/inspect').then(reason => {
    finished = true
    return reason
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  deliver()
  assert.equal(await pending, 'end_turn')
})

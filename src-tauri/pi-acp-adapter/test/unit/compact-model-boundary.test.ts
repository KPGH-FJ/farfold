import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const expected = {
  version: 1,
  sessionId: 'native',
  sessionFile: '/private/native.jsonl',
  provider: 'expected-provider',
  modelId: 'expected-model'
}

async function fixture() {
  const conn = new FakeAgentSideConnection()
  const state: Record<string, any> = {
    sessionId: expected.sessionId,
    sessionFile: expected.sessionFile,
    model: { provider: expected.provider, id: expected.modelId },
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0
  }
  const commands: Record<string, any>[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: null as unknown as Writable,
    kill() {
      return true
    }
  })
  const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n')
  const respond = (command: Record<string, any>, data: unknown, success = true) =>
    emit({ type: 'response', id: command.id, command: command.type, data, success })
  let held: Record<string, any> | undefined
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const command = JSON.parse(String(chunk))
      commands.push(command)
      if (command.type === 'get_state') respond(command, state)
      else if (command.type === 'compact') {
        held = command
        state.isCompacting = true
        emit({ type: 'compaction_start', reason: 'manual' })
      } else respond(command, {})
      done()
    }
  })
  const proc = Reflect.construct(PiRpcProcess, [child, { prefix: 'fixture:', dispose() {} }]) as PiRpcProcess
  const session = new PiAcpSession({
    sessionId: 'native',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn)
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
  })
  ;(agent as any).sessions = { maybeGet: () => session, get: () => session }
  const prompt = () =>
    agent.prompt({
      sessionId: 'native',
      prompt: [{ type: 'text', text: '/compact Keep facts' }],
      _meta: { farfoldPi: { hostTurnId: 'host-turn', expectedModel: expected } }
    })
  return {
    agent,
    session,
    proc,
    commands,
    state,
    prompt,
    finish(mode: 'success' | 'error' | 'missing' | 'aborted' = 'success') {
      assert.ok(held)
      state.isCompacting = false
      const result = { summary: 'Synthetic summary', firstKeptEntryId: 'entry-1', tokensBefore: 100 }
      if (mode !== 'missing')
        emit({
          type: 'compaction_end',
          reason: 'manual',
          willRetry: false,
          aborted: mode === 'aborted',
          ...(mode === 'success' ? { result } : mode === 'error' ? { errorMessage: 'synthetic failure' } : {})
        })
      respond(held, result, mode === 'success' || mode === 'missing')
    },
    dispose() {
      child.stdout.destroy()
      child.stdin.destroy()
    }
  }
}

test('managed /compact rejects stale model and complete identity/idle mismatch before native dispatch', async () => {
  for (const change of [
    { model: { provider: 'other', id: 'other' } },
    { sessionId: 'other' },
    { sessionFile: '/private/other.jsonl' },
    { isStreaming: true },
    { isCompacting: true },
    { pendingMessageCount: 1 },
    { isCompacting: undefined }
  ]) {
    const f = await fixture()
    try {
      Object.assign(f.state, change)
      await assert.rejects(f.prompt(), error => (error as any).data?.farfoldPiPromptNotSent === true)
      assert.equal(f.commands.filter(command => command.type === 'compact').length, 0)
      assert.equal(f.commands.filter(command => command.type === 'get_state').length, 1)
      assert.equal(f.session.hasActiveTurn, false)
    } finally {
      f.dispose()
    }
  }
})

test('compaction does not dispatch while profile/authentication is changing or connection is unknown', async () => {
  for (const field of ['refreshingProfile', 'authentication', 'failure']) {
    const f = await fixture()
    try {
      ;(f.proc as any)[field] = field === 'failure' ? new Error('synthetic unknown') : true
      await assert.rejects(f.prompt())
      assert.equal(f.commands.filter(command => command.type === 'compact').length, 0)
    } finally {
      f.dispose()
    }
  }
})

test('compaction owns the active slot; raced Stop is unsupported and never emits abort; completion restores Stop', async () => {
  const f = await fixture()
  try {
    const pending = f.prompt()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.session.hasActiveTurn, true)
    assert.equal(f.session.canCancel, false)
    await assert.rejects(f.prompt())
    await assert.rejects(f.session.prompt('another'))
    await assert.rejects(
      f.agent.setSessionConfigOption({ sessionId: 'native', configId: 'model', value: 'other/model' })
    )
    await assert.rejects(f.proc.setModel('other', 'model'))
    await assert.rejects(f.session.intervene('steer', 'must not queue'))
    assert.equal(f.commands.filter(command => command.type === 'set_model').length, 0)
    assert.deepEqual(await f.agent.extMethod('_pi/cancel', { sessionId: 'native' }), {
      version: 1,
      sessionId: 'native',
      outcome: 'unsupported'
    })
    await f.agent.cancel({ sessionId: 'native' })
    assert.equal(f.commands.filter(command => command.type === 'abort').length, 0)
    f.finish()
    const result = await pending
    assert.deepEqual(result, { stopReason: 'end_turn' }) // no fabricated Provider receipt
    assert.equal(f.session.hasActiveTurn, false)
    assert.equal(f.session.canCancel, true)
    assert.equal((await f.agent.extMethod('_pi/cancel', { sessionId: 'native' })).outcome, 'accepted')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.commands.filter(command => command.type === 'abort').length, 1)
    assert.equal(f.commands.filter(command => command.type === 'compact').length, 1)
  } finally {
    f.dispose()
  }
})

test('compaction requires native end, RPC result and final idle identity; missing end stays unknown', async () => {
  for (const mode of ['error', 'missing', 'aborted'] as const) {
    const f = await fixture()
    try {
      const pending = f.prompt()
      await new Promise(resolve => setImmediate(resolve))
      f.finish(mode)
      if (mode === 'aborted') assert.equal((await pending).stopReason, 'cancelled')
      else await assert.rejects(pending, error => (error as any).data?.farfoldOutcomeUnknown === (mode === 'missing'))
    } finally {
      f.dispose()
    }
  }
})

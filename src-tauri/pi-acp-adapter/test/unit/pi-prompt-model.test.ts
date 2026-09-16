import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { parsePromptModel } from '../../src/acp/pi-prompt-model.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiPromptNotSentError, PiRpcProcess, PiRpcRejectedError, type PiPromptModel } from '../../src/pi-rpc/process.js'

const expected: PiPromptModel = {
  sessionId: 'native',
  sessionFile: '/private/native.jsonl',
  provider: 'provider',
  modelId: 'native/model'
}

function fixture() {
  const state: Record<string, unknown> = {
    sessionId: expected.sessionId,
    sessionFile: expected.sessionFile,
    model: { provider: expected.provider, id: expected.modelId },
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0
  }
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: null as unknown as Writable,
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  })
  const commands: Array<Record<string, any>> = []
  let heldState: Record<string, any> | undefined
  const respond = (command: Record<string, any>, data: unknown, success: unknown = true) =>
    child.stdout.write(
      `${JSON.stringify({ type: 'response', id: command.id, command: command.type, data, success })}\n`
    )
  const hooks = {
    holdState: false,
    promptSuccess: true as unknown,
    promptWriteError: false
  }
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const command = JSON.parse(String(chunk))
      commands.push(command)
      if (command.type === 'get_state') {
        if (hooks.holdState) heldState = command
        else respond(command, state)
      } else if (command.type === 'prompt') {
        if (hooks.promptWriteError) {
          done(new Error('fixture transport failure'))
          return
        }
        respond(command, {}, hooks.promptSuccess)
      } else if (command.type !== 'extension_ui_response') respond(command, {})
      done()
    }
  })
  child.stdin.on('error', () => {})
  const proc = Reflect.construct(PiRpcProcess, [
    child,
    { prefix: 'private-fixture:', command: 'private-command', dispose() {} }
  ]) as PiRpcProcess
  return {
    proc,
    state,
    commands,
    hooks,
    releaseState() {
      assert.ok(heldState)
      respond(heldState, state)
      heldState = undefined
    },
    dispose() {
      child.stdout.destroy()
      child.stdin.destroy()
    }
  }
}

test('prompt model metadata is bounded, exact-session and contains only expected fields', () => {
  assert.deepEqual(parsePromptModel({ version: 1, ...expected }, 'native'), expected)
  assert.equal(parsePromptModel(undefined, 'native'), undefined)
  for (const value of [
    null,
    [],
    {},
    { version: 2, ...expected },
    { version: 1, ...expected, token: 'not-a-secret' },
    { version: 1, ...expected, sessionId: 'other' },
    { version: 1, ...expected, sessionFile: 'relative' },
    { version: 1, ...expected, provider: 'ambiguous/provider' },
    { version: 1, ...expected, modelId: '' },
    { version: 1, ...expected, provider: 'p'.repeat(200), modelId: 'm'.repeat(400) }
  ]) {
    assert.throws(() => parsePromptModel(value, 'native'), { code: -32602 })
  }
})

test('fresh native model preflight preserves the exact prompt and images without sending metadata to Pi', async () => {
  const f = fixture()
  try {
    const images = [{ type: 'image', data: 'fixture' }]
    await f.proc.prompt('Original message', images, expected)
    assert.deepEqual(
      f.commands.map(command => command.type),
      ['get_state', 'prompt']
    )
    const { id: _id, ...wire } = f.commands[1]
    assert.deepEqual(wire, { type: 'prompt', message: 'Original message', images })
  } finally {
    f.dispose()
  }
})

test('native model, session, file and idle mismatch are confirmed not sent', async () => {
  for (const patch of [
    { sessionId: 'other' },
    { sessionFile: '/other/native.jsonl' },
    { model: null },
    { model: { provider: 'other', id: expected.modelId } },
    { model: { provider: expected.provider, id: 'other' } },
    { isStreaming: true },
    { isCompacting: true },
    { pendingMessageCount: 1 },
    { isStreaming: null }
  ]) {
    const f = fixture()
    try {
      Object.assign(f.state, patch)
      await assert.rejects(f.proc.prompt('No send', [], expected), PiPromptNotSentError)
      assert.deepEqual(
        f.commands.map(command => command.type),
        ['get_state']
      )
    } finally {
      f.dispose()
    }
  }
})

test('preflight excludes configuration, another prompt and refresh while retaining read access', async () => {
  const f = fixture()
  try {
    f.hooks.holdState = true
    const prompt = f.proc.prompt('One task', [], expected)
    await assert.rejects(f.proc.setModel('other', 'model'), PiRpcRejectedError)
    await assert.rejects(f.proc.prompt('Other task'), PiRpcRejectedError)
    await assert.rejects(f.proc.prompt('Other guarded task', [], expected), PiPromptNotSentError)
    await assert.rejects(f.proc.refreshProfile(), PiRpcRejectedError)
    await f.proc.getMessages()
    f.releaseState()
    await prompt
    assert.equal(f.commands.filter(command => command.type === 'prompt').length, 1)
    assert.equal(f.commands.filter(command => command.type === 'set_model').length, 0)
  } finally {
    f.dispose()
  }
})

test('abort during model preflight prevents a late native prompt', async () => {
  const f = fixture()
  try {
    f.hooks.holdState = true
    const prompt = f.proc.prompt('Cancelled before send', [], expected)
    const rejected = assert.rejects(prompt, PiPromptNotSentError)
    await f.proc.abort()
    f.releaseState()
    await rejected
    assert.deepEqual(
      f.commands.map(command => command.type),
      ['get_state', 'abort']
    )
  } finally {
    f.dispose()
  }
})

test('late UI reply invalidates preflight then retains the original answer exactly once', async () => {
  const f = fixture()
  try {
    f.hooks.holdState = true
    const prompt = f.proc.prompt('No UI overlap', [], expected)
    const rejected = assert.rejects(prompt, PiPromptNotSentError)
    const answer = f.proc.sendExtensionUiResponse({ id: 'dialog', value: 'original answer' })
    assert.deepEqual(
      f.commands.map(command => command.type),
      ['get_state']
    )
    f.releaseState()
    await rejected
    await answer
    assert.deepEqual(
      f.commands.map(command => command.type),
      ['get_state', 'extension_ui_response']
    )
    assert.equal(f.commands[1].value, 'original answer')
  } finally {
    f.dispose()
  }
})

test('pending session interaction or cancellation rejects immediately before native dispatch', async () => {
  const f = fixture()
  try {
    await assert.rejects(
      f.proc.prompt('No dispatch', [], expected, () => false),
      PiPromptNotSentError
    )
    assert.deepEqual(
      f.commands.map(command => command.type),
      ['get_state']
    )
  } finally {
    f.dispose()
  }
})

test('timed-out preflight never dispatches when the native read returns late', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  try {
    f.hooks.holdState = true
    const rejected = assert.rejects(f.proc.prompt('No late task', [], expected), PiPromptNotSentError)
    t.mock.timers.tick(15000)
    await rejected
    f.releaseState()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(
      f.commands.map(command => command.type),
      ['get_state']
    )
  } finally {
    f.dispose()
    t.mock.timers.reset()
  }
})

test('a rejection or transport error after native prompt write is never classified as not sent', async () => {
  for (const writeError of [false, true]) {
    const f = fixture()
    try {
      f.hooks.promptSuccess = false
      f.hooks.promptWriteError = writeError
      await assert.rejects(f.proc.prompt('Already attempted', [], expected), error => {
        assert.ok(error instanceof Error)
        assert.equal(error instanceof PiPromptNotSentError, false)
        return true
      })
      assert.deepEqual(
        f.commands.map(command => command.type),
        ['get_state', 'prompt']
      )
    } finally {
      f.dispose()
    }
  }
})

test('post-write failure or malformed acknowledgement keeps the ACP session unknown and unusable', async () => {
  for (const malformed of [false, true]) {
    const f = fixture()
    try {
      f.hooks.promptWriteError = !malformed
      if (malformed) f.hooks.promptSuccess = 'not-a-boolean'
      const session = new PiAcpSession({
        sessionId: expected.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
        conn: asAgentConn(new FakeAgentSideConnection()),
        proc: f.proc
      })
      await assert.rejects(session.prompt('Uncertain dispatch', [], expected), error => {
        assert.deepEqual((error as { data?: unknown }).data, { farfoldOutcomeUnknown: true })
        return true
      })
      assert.equal(session.isUsable, false)
      await assert.rejects(session.prompt('No automatic retry', [], expected))
      assert.equal(f.commands.filter(command => command.type === 'prompt').length, 1)
    } finally {
      f.dispose()
    }
  }
})

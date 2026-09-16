import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'
import { PiRpcProcess, PiRpcRejectedError, PiModelRestoreMismatchError } from '../../src/pi-rpc/process.js'
import { createProfileExtension } from '../../src/pi-rpc/profile-extension.js'
import { PiNativeAuth } from '../../src/acp/native-auth.js'

async function loadGeneratedExtension(path: string) {
  // Unit Node resolves the same pinned public module by path; the Pi binary uses its official virtual module map.
  const sdk = new URL(
    '../../../capability-bridge/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    import.meta.url
  ).href
  const source = readFileSync(path, 'utf8')
  assert.ok(source.startsWith('import { buildSessionContext } from "@earendil-works/pi-coding-agent";'))
  return import(
    `data:text/javascript;base64,${Buffer.from(source.replace('"@earendil-works/pi-coding-agent"', JSON.stringify(sdk))).toString('base64')}`
  )
}

function fixture(originalModel?: { provider: string; modelId: string }) {
  const extension = createProfileExtension()
  const state = {
    sessionId: 'native',
    sessionFile: '/private/native.jsonl',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    model: { provider: 'provider', id: 'model' }
  }
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdout: new PassThrough(),
    stdin: null as unknown as Writable,
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  })
  const commands: Array<Record<string, any>> = []
  const events: unknown[] = []
  const emit = (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`)
  const respond = (command: Record<string, any>, data: unknown, success = true) =>
    emit({ type: 'response', id: command.id, command: command.type, success, data })
  const identity = () => ({ pid: child.pid, sessionId: state.sessionId, sessionFile: state.sessionFile })
  const hooks = {
    holdState: false,
    commandSource: extension.path,
    missing: false,
    onPrompt(command: Record<string, any>) {
      const parts = command.message.split(' ')
      const nativeFirstUse = command.message.startsWith(`/${extension.firstUseCommand} `)
        ? JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8'))
        : undefined
      emit({
        type: 'extension_ui_request',
        method: 'notify',
        message:
          extension.prefix +
          JSON.stringify({
            nonce: command.message.split(' ')[1],
            success: true,
            before: identity(),
            after: identity(),
            ...(command.message.startsWith(`/${extension.restoreCommand} `)
              ? {
                  operation: 'restore',
                  originalLeafRetained: true,
                  restoredModel: { provider: state.model.provider, modelId: state.model.id },
                  currentModel: { provider: state.model.provider, modelId: state.model.id }
                }
              : command.message.startsWith(`/${extension.firstUseCommand} `)
                ? { operation: 'first_use', firstUse: nativeFirstUse }
                : {})
          })
      })
      respond(command, {})
    },
    onOther(command: Record<string, any>) {
      respond(command, {})
    },
    finishWrite(_command: Record<string, any>, done: (error?: Error | null) => void) {
      done()
    }
  }
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const command = JSON.parse(String(chunk))
      commands.push(command)
      if (command.type === 'get_state') {
        if (!hooks.holdState) respond(command, state)
      } else if (command.type === 'get_commands')
        respond(command, {
          commands: hooks.missing
            ? []
            : [
                { name: extension.command, source: 'extension', sourceInfo: { path: hooks.commandSource } },
                { name: extension.restoreCommand, source: 'extension', sourceInfo: { path: hooks.commandSource } },
                { name: extension.firstUseCommand, source: 'extension', sourceInfo: { path: hooks.commandSource } },
                { name: 'user-command', source: 'extension', sourceInfo: { path: '/user/extension.ts' } }
              ]
        })
      else if (command.type === 'prompt') hooks.onPrompt(command)
      else hooks.onOther(command)
      hooks.finishWrite(command, done)
    }
  })
  const proc = Reflect.construct(PiRpcProcess, [
    child,
    extension,
    originalModel ? { model: originalModel, assertUnchanged() {} } : undefined
  ]) as PiRpcProcess
  proc.onEvent(event => events.push(event))
  const dispose = () => {
    child.stdout.destroy()
    extension.dispose()
  }
  return { proc, child, state, hooks, commands, events, emit, respond, extension, identity, dispose }
}

test('native authentication lease excludes all model, task, profile and UI writes but permits owned refresh and abort', async () => {
  const f = fixture()
  try {
    const lease = f.proc.beginAuthentication()
    assert.throws(() => f.proc.beginAuthentication(), PiRpcRejectedError)
    await assert.rejects(f.proc.setModel('other', 'model'), PiRpcRejectedError)
    await assert.rejects(f.proc.prompt('must not send'), PiRpcRejectedError)
    await assert.rejects(f.proc.refreshProfile(), PiRpcRejectedError)
    await assert.rejects(f.proc.sendExtensionUiResponse({ id: 'ui', value: 'private' }), PiRpcRejectedError)
    await f.proc.abort()
    await lease.refresh()
    assert.deepEqual(
      f.commands.filter(command => !command.type.startsWith('get_')).map(command => command.type),
      ['abort', 'prompt']
    )
    assert.equal(
      f.commands.some(command => JSON.stringify(command).includes('private')),
      false
    )
    lease.release()
    await f.proc.setModel('provider', 'model')
    assert.equal(f.commands.at(-1)?.type, 'set_model')
  } finally {
    f.dispose()
  }
})

test('cancelling an unanswered real RPC preparation releases its lease without waiting for Pi or starting SDK login', async () => {
  const f = fixture()
  let sdkCalls = 0
  let finished = false
  const auth = new PiNativeAuth(async () => {
    sdkCalls++
    throw new Error('SDK must not start')
  })
  try {
    f.hooks.holdState = true
    const lease = f.proc.beginAuthentication()
    const flow = auth.start(
      { sessionId: 'native', providerId: 'anthropic', authType: 'api_key' },
      {
        root: '/owned',
        prepare: async signal => {
          await f.proc.getState()
          signal.throwIfAborted()
        },
        refresh: async () => {
          assert.fail('No refresh after cancellation')
        },
        finish: blocked => {
          assert.equal(blocked, false)
          finished = true
          lease.release()
        }
      }
    )
    assert.equal(f.commands.at(-1)?.type, 'get_state')
    auth.cancel('native', flow.flowId)
    for (let i = 0; i < 100 && !finished; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(finished, true, 'Cancellation must not depend on the held Pi response')
    assert.equal(auth.status('native', flow.flowId).state, 'cancelled')
    assert.equal(auth.status('native', flow.flowId).credentialState, 'not_attempted')
    const next = f.proc.beginAuthentication()
    next.release()
    f.respond(f.commands[0], f.state)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sdkCalls, 0)
    assert.equal(f.commands.length, 1)
  } finally {
    auth.dispose()
    f.dispose()
  }
})

test('private extension refresh uses official context, denies malformed input and sanitizes native failures', async () => {
  const extension = createProfileExtension()
  try {
    assert.equal(statSync(extension.path).mode & 0o777, 0o600)
    let handler!: (args: string, context: unknown) => Promise<void>
    const loaded = await loadGeneratedExtension(extension.path)
    loaded.default({
      registerCommand(name: string, options: { handler: typeof handler }) {
        if (name === extension.restoreCommand || name === extension.firstUseCommand) return
        assert.equal(name, extension.command)
        handler = options.handler
      }
    })
    const messages: string[] = []
    let calls = 0
    let fail = false
    const context = {
      modelRegistry: {
        async refresh(options: unknown) {
          assert.deepEqual(options, { allowNetwork: false })
          calls++
          if (fail) throw new Error('SECRET-CREDENTIAL')
        }
      },
      sessionManager: { getSessionId: () => 'native', getSessionFile: () => '/private/native.jsonl' },
      ui: {
        notify(message: string) {
          messages.push(message)
        }
      }
    }
    await handler('invalid', context)
    assert.equal(calls, 0)
    await handler('a'.repeat(48), context)
    assert.equal(JSON.parse(messages[0].slice(extension.prefix.length)).success, true)
    fail = true
    await handler('b'.repeat(48), context)
    assert.equal(JSON.parse(messages[1].slice(extension.prefix.length)).success, false)
    assert.equal(messages.join('').includes('SECRET'), false)
  } finally {
    extension.dispose()
  }
})

test('refresh confirms native process identity and consumes only its private acknowledgement', async () => {
  const f = fixture()
  try {
    await f.proc.refreshProfile()
    assert.equal(f.commands.filter(command => command.type === 'prompt').length, 1)
    assert.deepEqual(f.events, [])
    assert.deepEqual(await f.proc.getCommands(), {
      commands: [{ name: 'user-command', source: 'extension', sourceInfo: { path: '/user/extension.ts' } }]
    })
    const notice = { type: 'extension_ui_request', method: 'notify', message: 'Native user notification' }
    f.emit(notice)
    assert.deepEqual(f.events, [notice])
    assert.equal(f.child.killed, false)
  } finally {
    f.dispose()
  }
})

test('native first-use state is appended through the owned Pi extension and acknowledged exactly', async () => {
  const f = fixture()
  try {
    const state = { version: 1 as const, phase: 'authentication_required' as const }
    const lease = f.proc.beginAuthentication()
    await lease.recordNativeFirstUse(state)
    lease.release()
    const prompt = f.commands.find(command => command.type === 'prompt')
    assert.equal(prompt?.message.startsWith(`/${f.extension.firstUseCommand} `), true)
    assert.equal(f.child.killed, false)
    assert.deepEqual(f.events, [])
  } finally {
    f.dispose()
  }
})

test('owned restore observation uses the pinned native branch parser and does not expose history or errors', async () => {
  const extension = createProfileExtension('selected')
  try {
    let handler!: (args: string, context: unknown) => Promise<void>
    const loaded = await loadGeneratedExtension(extension.path)
    loaded.default({
      registerCommand(name: string, options: { handler: typeof handler }) {
        if (name === extension.restoreCommand) handler = options.handler
      }
    })
    const entries = [
      { id: 'root', parentId: null, type: 'model_change', provider: 'provider-a', modelId: 'root-model' },
      {
        id: 'selected',
        parentId: 'root',
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'provider-a',
          model: 'selected-model',
          content: [{ type: 'text', text: 'PRIVATE-HISTORY' }]
        }
      },
      {
        id: 'other-branch',
        parentId: 'root',
        type: 'model_change',
        provider: 'provider-b',
        modelId: 'not-the-selected-model'
      },
      {
        id: 'other-marker',
        parentId: 'other-branch',
        type: 'custom',
        customType: 'farfold-native-first-use-v1',
        data: { version: 1, phase: 'ready', provider: 'provider-b', modelId: 'not-the-selected-model' }
      }
    ]
    const original = JSON.stringify(entries)
    const messages: string[] = []
    let fail = false
    let leaf: string | null = 'selected'
    const context = {
      model: { provider: 'provider-a', id: 'selected-model' },
      modelRegistry: {
        refresh() {
          throw new Error('Read-only restore check must not refresh')
        }
      },
      sessionManager: {
        getSessionId: () => 'native',
        getSessionFile: () => '/private/native.jsonl',
        getEntries() {
          if (fail) throw new Error('PRIVATE-HISTORY-ERROR')
          return entries
        },
        getLeafId: () => leaf,
        getBranch: () => (leaf === 'selected' ? entries.slice(0, 2) : [])
      },
      ui: {
        notify(message: string) {
          messages.push(message)
        }
      }
    }
    await handler('a'.repeat(48), context)
    assert.deepEqual(JSON.parse(messages[0].slice(extension.prefix.length)).restoredModel, {
      provider: 'provider-a',
      modelId: 'selected-model'
    })
    assert.equal(JSON.stringify(entries), original)
    assert.equal(JSON.parse(messages[0].slice(extension.prefix.length)).originalLeafRetained, true)
    assert.equal(JSON.parse(messages[0].slice(extension.prefix.length)).firstUse, null)
    leaf = null
    await handler('b'.repeat(48), context)
    assert.equal(JSON.parse(messages[1].slice(extension.prefix.length)).restoredModel, null)
    assert.equal(JSON.parse(messages[1].slice(extension.prefix.length)).originalLeafRetained, false)
    fail = true
    await handler('c'.repeat(48), context)
    const failed = JSON.parse(messages[2].slice(extension.prefix.length))
    assert.equal(failed.success, false)
    assert.equal(failed.failureReason, 'history_unavailable')
    assert.equal(messages.join('').includes('PRIVATE-HISTORY'), false)
  } finally {
    extension.dispose()
  }
})

test('post-launch agreement cannot replace the pre-launch original model or leaf authority', async () => {
  const f = fixture({ provider: 'original-provider', modelId: 'original-model' })
  try {
    await assert.rejects(f.proc.verifyRestoredModel(), PiModelRestoreMismatchError)
    f.state.model = { provider: 'original-provider', id: 'original-model' }
    await f.proc.verifyRestoredModel()
    const acknowledge = f.hooks.onPrompt
    f.hooks.onPrompt = command => {
      f.emit({
        type: 'extension_ui_request',
        method: 'notify',
        message:
          f.extension.prefix +
          JSON.stringify({
            nonce: command.message.split(' ')[1],
            operation: 'restore',
            success: true,
            before: f.identity(),
            after: f.identity(),
            originalLeafRetained: false,
            restoredModel: { provider: 'original-provider', modelId: 'original-model' },
            currentModel: { provider: 'original-provider', modelId: 'original-model' }
          })
      })
      f.respond(command, {})
    }
    await assert.rejects(
      f.proc.verifyRestoredModel(),
      error => error instanceof PiModelRestoreMismatchError && error.reason === 'history_unavailable'
    )
    f.hooks.onPrompt = acknowledge
  } finally {
    f.dispose()
  }
})

test('restore validation uses its owned command, exact native identities and original model without refreshing', async () => {
  const f = fixture()
  try {
    await f.proc.verifyRestoredModel()
    const prompts = f.commands.filter(command => command.type === 'prompt')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].message.startsWith(`/${f.extension.restoreCommand} `), true)
    assert.deepEqual(f.events, [])
    assert.equal(f.child.killed, false)
  } finally {
    f.dispose()
  }
})

test('a proven restored-model mismatch is rejected while missing provenance never invokes a command', async () => {
  for (const reason of ['model', 'missing', 'foreign', 'identity', 'operation']) {
    const f = fixture()
    try {
      if (reason === 'missing') f.hooks.missing = true
      if (reason === 'foreign') f.hooks.commandSource = '/other/profile.mjs'
      f.hooks.onPrompt = command => {
        f.emit({
          type: 'extension_ui_request',
          method: 'notify',
          message:
            f.extension.prefix +
            JSON.stringify({
              nonce: command.message.split(' ')[1],
              operation: reason === 'operation' ? 'refresh' : 'restore',
              success: true,
              before: f.identity(),
              after: { ...f.identity(), ...(reason === 'identity' ? { sessionId: 'other' } : {}) },
              restoredModel: { provider: 'original-provider', modelId: 'model' },
              currentModel: { provider: 'provider', modelId: 'model' }
            })
        })
        f.respond(command, {})
      }
      if (reason === 'model') {
        await assert.rejects(f.proc.verifyRestoredModel(), PiModelRestoreMismatchError)
        assert.equal(f.child.killed, false)
      } else if (reason === 'missing' || reason === 'foreign') {
        await assert.rejects(f.proc.verifyRestoredModel(), PiRpcRejectedError)
        assert.equal(
          f.commands.some(command => command.type === 'prompt'),
          false
        )
      } else {
        await assert.rejects(f.proc.verifyRestoredModel(), /outcome is unknown/)
        assert.equal(f.child.killed, true)
      }
    } finally {
      f.dispose()
    }
  }
})

test('missing or foreign command and busy native state never fall through to an Agent prompt', async () => {
  for (const reason of ['missing', 'foreign', 'streaming', 'pending', 'compacting']) {
    const f = fixture()
    try {
      if (reason === 'missing') f.hooks.missing = true
      if (reason === 'foreign') f.hooks.commandSource = '/other/profile.mjs'
      if (reason === 'streaming') f.state.isStreaming = true
      if (reason === 'pending') f.state.pendingMessageCount = 1
      if (reason === 'compacting') f.state.isCompacting = true
      await assert.rejects(f.proc.refreshProfile(), PiRpcRejectedError)
      assert.equal(
        f.commands.some(command => command.type === 'prompt'),
        false
      )
      assert.equal(f.child.killed, false)
    } finally {
      f.dispose()
    }
  }
})

test('refresh excludes overlapping profile, model and prompt writes while preserving abort', async () => {
  const f = fixture()
  try {
    let release!: () => void
    const original = f.hooks.onPrompt
    f.hooks.onPrompt = command => {
      release = () => original(command)
    }
    const refresh = f.proc.refreshProfile()
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(f.proc.refreshProfile(), PiRpcRejectedError)
    await assert.rejects(f.proc.setModel('provider', 'model'), PiRpcRejectedError)
    await assert.rejects(f.proc.prompt('Not sent'), PiRpcRejectedError)
    await f.proc.abort()
    release()
    await refresh
    assert.equal(f.commands.filter(command => command.type === 'prompt').length, 1)
    assert.equal(
      f.commands.some(command => command.type === 'set_model'),
      false
    )
  } finally {
    f.dispose()
  }
})

test('pending native mutation prevents profile refresh admission', async () => {
  const f = fixture()
  try {
    let release!: () => void
    f.hooks.onOther = command => {
      release = () => f.respond(command, {})
    }
    const changing = f.proc.setModel('provider', 'model')
    await assert.rejects(f.proc.refreshProfile(), PiRpcRejectedError)
    release()
    await changing
    assert.equal(f.commands.length, 1)
  } finally {
    f.dispose()
  }
})

test('native UI reply waits for refresh and then delivers exactly once without losing its identity', async () => {
  const f = fixture()
  try {
    let release!: () => void
    const original = f.hooks.onPrompt
    f.hooks.onPrompt = command => {
      release = () => original(command)
    }
    const refresh = f.proc.refreshProfile()
    await new Promise(resolve => setImmediate(resolve))
    const reply = f.proc.sendExtensionUiResponse({ id: 'valid-dialog', value: 'Keep this answer' })
    const overlapped = f.commands.some(command => command.type === 'extension_ui_response')
    release()
    await refresh
    await reply
    assert.equal(overlapped, false)
    assert.deepEqual(
      f.commands.filter(command => command.type === 'extension_ui_response'),
      [{ type: 'extension_ui_response', id: 'valid-dialog', value: 'Keep this answer' }]
    )
  } finally {
    f.dispose()
  }
})

test('uncompleted UI write prevents refresh admission', async () => {
  const f = fixture()
  try {
    let release!: () => void
    f.hooks.finishWrite = (command, done) => {
      if (command.type === 'extension_ui_response') release = () => done()
      else done()
    }
    const reply = f.proc.sendExtensionUiResponse({ id: 'valid-dialog', confirmed: true })
    const refresh = f.proc.refreshProfile().then(
      () => null,
      error => error
    )
    await new Promise(resolve => setImmediate(resolve))
    release()
    await reply
    assert.equal((await refresh) instanceof PiRpcRejectedError, true)
    assert.equal(
      f.commands.some(command => command.type === 'prompt'),
      false
    )
  } finally {
    f.dispose()
  }
})

test('queued UI answer is not written or retried after an unknown refresh closes the connection', async () => {
  const f = fixture()
  try {
    let rejectRefresh!: () => void
    f.hooks.onPrompt = command => {
      rejectRefresh = () => {
        f.emit({ type: 'extension_ui_request', method: 'notify', message: f.extension.prefix + '{}' })
        f.respond(command, {})
      }
    }
    const refresh = assert.rejects(f.proc.refreshProfile(), /outcome is unknown/)
    await new Promise(resolve => setImmediate(resolve))
    const reply = assert.rejects(
      f.proc.sendExtensionUiResponse({ id: 'valid-dialog', confirmed: true }),
      /connection is closed/
    )
    rejectRefresh()
    await refresh
    await reply
    assert.equal(
      f.commands.some(command => command.type === 'extension_ui_response'),
      false
    )
    assert.equal(f.child.killed, true)
  } finally {
    f.dispose()
  }
})

test('invalid acknowledgements retain unknown, close the process and prevent subsequent work', async () => {
  for (const reason of ['nonce', 'pid', 'session', 'file', 'failed', 'malformed', 'idle']) {
    const f = fixture()
    try {
      f.hooks.onPrompt = command => {
        const ack = { nonce: command.message.split(' ')[1], success: true, before: f.identity(), after: f.identity() }
        if (reason === 'nonce') ack.nonce = 'old'
        if (reason === 'pid') ack.after.pid++
        if (reason === 'session') ack.after.sessionId = 'other'
        if (reason === 'file') ack.after.sessionFile = '/other.jsonl'
        if (reason === 'failed') ack.success = false
        if (reason === 'idle') f.state.isStreaming = true
        f.emit({
          type: 'extension_ui_request',
          method: 'notify',
          message: f.extension.prefix + (reason === 'malformed' ? 'SECRET-NOT-JSON' : JSON.stringify(ack))
        })
        f.respond(command, {})
      }
      await assert.rejects(f.proc.refreshProfile(), /^Error: Pi profile refresh outcome is unknown$/)
      assert.equal(f.child.killed, true)
      await assert.rejects(f.proc.prompt('Not sent'))
      assert.deepEqual(f.events, [{ type: 'pi_acp_transport_closed' }])
    } finally {
      f.dispose()
    }
  }
})

test('lost acknowledgement times out without claiming a refreshed profile', async t => {
  const f = fixture()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    f.hooks.onPrompt = command => {
      f.respond(command, {})
    }
    const failed = assert.rejects(f.proc.refreshProfile(), /outcome is unknown/)
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(15000)
    await failed
    assert.equal(f.child.killed, true)
  } finally {
    t.mock.timers.reset()
    f.dispose()
  }
})

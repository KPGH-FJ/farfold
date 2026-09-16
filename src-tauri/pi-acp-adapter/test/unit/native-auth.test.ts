import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PiNativeAuth,
  nativeAuthCommand,
  assertPrivateAuthProfile,
  createNativeAuthBackend,
  type NativeAuthRuntime
} from '../../src/acp/native-auth.js'
import { loadPiSdk } from '../../src/pi-rpc/sdk.js'

async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('Authentication condition did not settle')
}

function fixture(
  login: NativeAuthRuntime['login'],
  options?: { refresh?: () => Promise<void>; prepare?: () => Promise<void> }
) {
  let refreshes = 0
  const finished: boolean[] = []
  const auth = new PiNativeAuth(async () => ({
    runtime: { getProvider: () => ({ auth: { apiKey: { login() {} }, oauth: { login() {} } } }), login },
    synchronizedCredentialError: error => error === synchronizationError
  }))
  const snapshot = auth.start(
    { sessionId: 'native', providerId: 'anthropic', authType: 'api_key' },
    {
      root: '/owned',
      prepare: options?.prepare ?? (async () => {}),
      refresh: async () => {
        refreshes++
        await options?.refresh?.()
      },
      finish: blocked => finished.push(blocked)
    }
  )
  const status = () => auth.status('native', snapshot.flowId)
  return { auth, snapshot, status, finished, refreshes: () => refreshes }
}
const synchronizationError = Object.assign(new Error('secret raw SDK failure'), { credential: { key: 'private' } })

test('authentication replies are ephemeral, exact and single-use; only confirmed refresh releases work', async () => {
  const f = fixture(async (_provider, _type, interaction) => {
    const key = await interaction.prompt({ type: 'secret', message: 'API key' })
    assert.equal(key, 'synthetic-secret')
    return { type: 'api_key', key }
  })
  await until(() => !!f.status().prompt)
  assert.equal(f.auth.blocksWork, true)
  assert.throws(() => f.auth.reply('other', f.snapshot.flowId, f.status().prompt!.id, 'synthetic-secret'))
  const id = f.status().prompt!.id
  const reply = f.auth.reply('native', f.snapshot.flowId, id, 'synthetic-secret')
  assert.equal(reply.prompt, null)
  assert.throws(() => f.auth.reply('native', f.snapshot.flowId, id, 'synthetic-secret'))
  await until(() => f.finished.length > 0)
  assert.deepEqual(
    [f.status().state, f.status().credentialState, f.status().refreshState],
    ['succeeded', 'committed', 'confirmed']
  )
  assert.equal(JSON.stringify(f.status()).includes('synthetic-secret'), false)
  assert.deepEqual(f.finished, [false])
  assert.equal(f.refreshes(), 1)
  assert.equal(f.auth.blocksWork, false)
  f.auth.dispose()
})

test('a cancelled SDK prompt clears immediately, rejects late responses and never retries or claims no write', async () => {
  const f = fixture(async (_provider, _type, interaction) =>
    interaction.prompt({ type: 'manual_code', message: 'Code' })
  )
  await until(() => !!f.status().prompt)
  const id = f.status().prompt!.id
  f.auth.cancel('native', f.snapshot.flowId)
  assert.equal(f.status().prompt, null)
  assert.throws(() => f.auth.reply('native', f.snapshot.flowId, id, 'late-code'))
  await until(() => f.finished.length > 0)
  assert.deepEqual([f.status().state, f.status().credentialState], ['unknown', 'unknown'])
  assert.equal(f.refreshes(), 0)
  assert.equal(f.auth.blocksWork, true)
  f.auth.dispose()
})

test('SDK per-prompt abort withdraws only that prompt while OAuth callback may still commit', async () => {
  const step = new AbortController()
  let callback!: () => void
  const callbackResult = new Promise<void>(resolve => {
    callback = resolve
  })
  const f = fixture(async (_provider, _type, interaction) => {
    await interaction.prompt({ type: 'manual_code', message: 'Code', signal: step.signal }).catch(() => {})
    await callbackResult
    assert.equal(interaction.signal.aborted, false)
    return { type: 'oauth', access: 'private' }
  })
  await until(() => !!f.status().prompt)
  step.abort()
  assert.equal(f.status().prompt, null)
  callback()
  await until(() => f.finished.length > 0)
  assert.equal(f.status().state, 'succeeded')
  f.auth.dispose()
})

test('credential synchronization failure and refresh failure remain committed, blocked and sanitized', async () => {
  for (const synchronization of [true, false]) {
    const f = fixture(
      async () => {
        if (synchronization) throw synchronizationError
        return { access: 'private' }
      },
      {
        refresh: async () => {
          throw new Error('private')
        }
      }
    )
    await until(() => f.finished.length > 0)
    assert.equal(f.status().state, 'unknown')
    assert.equal(f.status().credentialState, 'committed')
    assert.equal(f.refreshes(), synchronization ? 0 : 1)
    assert.equal(f.auth.blocksWork, true)
    assert.doesNotMatch(JSON.stringify(f.status()), /private|secret raw/)
    f.auth.dispose()
  }
})

test('cancellation before SDK entry is not attempted; late successful SDK commit is not mislabeled cancelled', async () => {
  let prepare!: () => void
  const preparation = new Promise<void>(resolve => {
    prepare = resolve
  })
  let calls = 0
  const early = fixture(
    async () => {
      calls++
    },
    { prepare: () => preparation }
  )
  early.auth.cancel('native', early.snapshot.flowId)
  await until(() => early.finished.length > 0)
  assert.equal(calls, 0)
  assert.deepEqual([early.status().state, early.status().credentialState], ['cancelled', 'not_attempted'])
  prepare()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
  early.auth.dispose()

  let commit!: () => void
  const committed = new Promise<void>(resolve => {
    commit = resolve
  })
  const late = fixture(async () => {
    calls++
    await committed
    return { key: 'private' }
  })
  await until(() => calls > 0)
  late.auth.cancel('native', late.snapshot.flowId)
  assert.equal(late.auth.blocksWork, true)
  commit()
  await until(() => late.finished.length > 0)
  assert.deepEqual([late.status().state, late.status().credentialState], ['unknown', 'committed'])
  assert.equal(late.refreshes(), 0)
  late.auth.dispose()
})

test('select bounds, input schema, disposal and rejected notice details cannot leak credentials', async () => {
  assert.equal(
    nativeAuthCommand.safeParse({
      action: 'start',
      sessionId: 'native',
      providerId: 'farfold-managed-a',
      authType: 'oauth'
    }).success,
    false
  )
  assert.equal(
    nativeAuthCommand.safeParse({
      action: 'reply',
      sessionId: 'native',
      flowId: 'f',
      promptId: 'p',
      value: 'x'.repeat(65537)
    }).success,
    false
  )
  const f = fixture(async (_provider, _type, interaction) => {
    await interaction.prompt({ type: 'select', message: 'Account', options: [{ id: 'first', label: 'First' }] })
    interaction.notify({ type: 'auth_url', url: 'https://secret:password@example.com/' })
  })
  await until(() => !!f.status().prompt)
  const id = f.status().prompt!.id
  assert.throws(() => f.auth.reply('native', f.snapshot.flowId, id, 'wrong'))
  f.auth.reply('native', f.snapshot.flowId, id, 'first')
  await until(() => f.finished.length > 0)
  assert.equal(f.status().state, 'unknown')
  assert.doesNotMatch(JSON.stringify(f.status()), /password|https:/)
  f.auth.dispose()
  assert.throws(() => f.status())
})

test('owned authentication paths reject aliases, nonprivate files and managed auth shadows', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'farfold-native-auth-')))
  try {
    assertPrivateAuthProfile(root)
    writeFileSync(join(root, 'auth.json'), '{}', { mode: 0o644 })
    assert.throws(() => assertPrivateAuthProfile(root))
    rmSync(join(root, 'auth.json'))
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({ 'farfold-managed-alias': { type: 'api_key', key: 'synthetic' } }),
      { mode: 0o600 }
    )
    assert.throws(() => assertPrivateAuthProfile(root))
    rmSync(join(root, 'auth.json'))
    writeFileSync(join(root, 'original.json'), '{}', { mode: 0o600 })
    symlinkSync(join(root, 'original.json'), join(root, 'auth.json'))
    assert.throws(() => assertPrivateAuthProfile(root))
    assert.equal(readFileSync(join(root, 'original.json'), 'utf8'), '{}')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fixed public SDK login writes only synthetic isolated credentials without an Agent or model request', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'farfold-native-sdk-auth-')))
  const nodePath = new URL('../../../resources/pi-capabilities/runtime/node', import.meta.url).pathname
  try {
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({ 'retained-provider': { type: 'api_key', key: 'retained-synthetic' } }),
      { mode: 0o600 }
    )
    const controller = new AbortController()
    const backend = await createNativeAuthBackend(root, controller.signal, () => loadPiSdk(nodePath))
    let prompts = 0
    await backend.runtime.login('anthropic', 'api_key', {
      signal: controller.signal,
      prompt: async prompt => {
        assert.equal(prompt.type, 'secret')
        prompts++
        return 'synthetic-native-key'
      },
      notify() {}
    })
    assert.equal(prompts, 1)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')), {
      'retained-provider': { type: 'api_key', key: 'retained-synthetic' },
      anthropic: { type: 'api_key', key: 'synthetic-native-key' }
    })
    await backend.runtime.logout!('anthropic', { signal: controller.signal })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'auth.json'), 'utf8')), {
      'retained-provider': { type: 'api_key', key: 'retained-synthetic' }
    })
    assertPrivateAuthProfile(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('logout shares commit/refresh exclusion, never asks for a secret and does not call login', async () => {
  for (const refreshFailure of [false, true]) {
    let finished = false
    let removals = 0
    const auth = new PiNativeAuth(async () => ({
      runtime: {
        getProvider: () => undefined,
        login: async () => assert.fail('Logout must not invoke login'),
        logout: async provider => {
          assert.equal(provider, 'anthropic')
          removals++
        }
      },
      synchronizedCredentialError: () => false
    }))
    const flow = auth.start(
      { sessionId: 'native', providerId: 'anthropic', authType: 'oauth', operation: 'logout' },
      {
        root: '/owned',
        prepare: async () => {},
        refresh: async () => {
          if (refreshFailure) throw new Error('private')
        },
        finish: () => {
          finished = true
        }
      }
    )
    await until(() => finished)
    const snapshot = auth.status('native', flow.flowId)
    assert.equal(snapshot.operation, 'logout')
    assert.equal(snapshot.state, refreshFailure ? 'unknown' : 'succeeded')
    assert.equal(snapshot.credentialState, 'committed')
    assert.equal(snapshot.prompt, null)
    assert.equal(removals, 1)
    assert.equal(auth.blocksWork, refreshFailure)
    auth.dispose()
  }
})

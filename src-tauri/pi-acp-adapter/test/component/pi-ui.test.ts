import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSideConnection, CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import { PiUiBridge, supportsPiExtensions } from '../../src/acp/pi-ui.js'

function fixture() {
  const requests: CreateElicitationRequest[] = []
  const notices: unknown[] = []
  const replies: unknown[] = []
  let answer: CreateElicitationResponse = { action: 'accept', content: { value: '' } }
  let resolver: ((value: CreateElicitationResponse) => void) | undefined
  let delay = false
  const conn: Pick<AgentSideConnection, 'unstable_createElicitation' | 'extNotification'> = {
    async unstable_createElicitation(request) {
      requests.push(request)
      if (delay)
        return new Promise(resolve => {
          resolver = resolve
        })
      return answer
    },
    async extNotification(method, params) {
      notices.push({ method, params })
    }
  }
  const bridge = new PiUiBridge('native-a', conn, async reply => {
    replies.push(reply)
  })
  return {
    bridge,
    requests,
    notices,
    replies,
    setAnswer(value: CreateElicitationResponse) {
      answer = value
    },
    hold() {
      delay = true
    },
    finish(value: CreateElicitationResponse) {
      assert.ok(resolver)
      resolver(value)
    }
  }
}

test('Pi extensions require exact version and form capability', () => {
  assert.equal(supportsPiExtensions({ _meta: { farfoldPi: { version: 1 } }, elicitation: { form: {} } }), true)
  for (const capabilities of [
    null,
    {},
    { _meta: { farfoldPi: { version: 1 } } },
    { _meta: { farfoldPi: { version: 2 } }, elicitation: { form: {} } }
  ])
    assert.equal(supportsPiExtensions(capabilities), false)
})

test('four native dialogs use form, preserving false, empty and multiline values', async () => {
  const f = fixture()
  for (const [method, value] of [
    ['select', 'Two'],
    ['confirm', false],
    ['input', ''],
    ['editor', 'Edited\nline']
  ] as const) {
    f.setAnswer({ action: 'accept', content: { value } })
    await f.bridge.handle({
      id: method,
      method,
      title: 'Title',
      options: ['One', 'Two'],
      prefill: 'Original',
      placeholder: 'Hint'
    })
    assert.deepEqual(f.replies.at(-1), method === 'confirm' ? { id: method, confirmed: false } : { id: method, value })
    assert.equal(f.requests.at(-1)?.mode, 'form')
    assert.equal(f.requests.at(-1)?._meta?.sessionId, 'native-a')
  }
  assert.equal(f.notices.length, 0)
})

test('five native notifications preserve their payload and never receive dialog replies', async () => {
  const f = fixture()
  for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
    const event = {
      id: method,
      method,
      statusKey: 'key',
      statusText: '',
      widgetLines: [],
      widgetPlacement: 'belowEditor',
      text: 'draft'
    }
    await f.bridge.handle(event)
    assert.deepEqual(f.notices.at(-1), { method: '_pi/ui', params: { sessionId: 'native-a', version: 1, event } })
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.replies.length, 0)
})

test('decline and cancel remain native cancellation, not confirm false', async () => {
  const f = fixture()
  for (const action of ['decline', 'cancel'] as const) {
    f.setAnswer({ action })
    await f.bridge.handle({ id: action, method: 'confirm', title: 'Continue?' })
    assert.deepEqual(f.replies.at(-1), { id: action, cancelled: true })
  }
})

test('cancel invalidates a pending reply before allowing the next dialog', async () => {
  const f = fixture()
  f.hold()
  const pending = f.bridge.handle({ id: 'old', method: 'input', title: 'Old' })
  await f.bridge.invalidate()
  await pending
  assert.deepEqual(f.notices, [
    {
      method: '_pi/ui_withdrawn',
      params: { sessionId: 'native-a', version: 1, nativeRequestId: 'old', reason: 'cancelled' }
    }
  ])
  f.finish({ action: 'accept', content: { value: 'late' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.replies, [{ id: 'old', cancelled: true }])
  await assert.rejects(f.bridge.handle({ id: 'old', method: 'input', title: 'Reuse' }))
})

test('connection close drops old replies and rejects subsequent UI', async () => {
  const f = fixture()
  f.hold()
  const pending = f.bridge.handle({ id: 'old', method: 'editor', title: 'Old' })
  await f.bridge.invalidate(true)
  await pending
  assert.deepEqual(f.notices, [
    {
      method: '_pi/ui_withdrawn',
      params: { sessionId: 'native-a', version: 1, nativeRequestId: 'old', reason: 'connection_closed' }
    }
  ])
  f.finish({ action: 'accept', content: { value: 'late' } })
  assert.deepEqual(f.replies, [])
  await assert.rejects(f.bridge.handle({ id: 'new', method: 'input', title: 'New' }))
})

test('cancel wins over an already-resolved response not yet dispatched to Pi', async () => {
  const f = fixture()
  f.setAnswer({ action: 'accept', content: { value: 'too late' } })
  const pending = f.bridge.handle({ id: 'race', method: 'input', title: 'Race' })
  await f.bridge.invalidate()
  await pending
  assert.deepEqual(f.replies, [{ id: 'race', cancelled: true }])
})

test('native timeout cancels once and discards a late answer', async () => {
  const f = fixture()
  f.hold()
  await f.bridge.handle({ id: 'timed', method: 'input', title: 'Timed', timeout: 5 })
  assert.deepEqual(f.notices, [
    {
      method: '_pi/ui_withdrawn',
      params: { sessionId: 'native-a', version: 1, nativeRequestId: 'timed', reason: 'timeout' }
    }
  ])
  f.finish({ action: 'accept', content: { value: 'late' } })
  assert.deepEqual(f.replies, [{ id: 'timed', cancelled: true }])
})

test('invalid native options and out-of-schema client answers cannot write to Pi', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.handle({ id: 'bad', method: 'select', title: 'Bad', options: [42] }))
  f.setAnswer({ action: 'accept', content: { value: 'outside' } })
  await assert.rejects(f.bridge.handle({ id: 'choice', method: 'select', title: 'Pick', options: ['One'] }))
  assert.equal(f.replies.length, 0)
})

test('unanswered remote forms remain bounded even after local timeout', async () => {
  const resolvers: Array<(value: CreateElicitationResponse) => void> = []
  const conn = {
    unstable_createElicitation: () => new Promise<CreateElicitationResponse>(resolve => resolvers.push(resolve)),
    extNotification: async () => {}
  }
  const bridge = new PiUiBridge('native-a', conn, async () => {})
  for (let i = 0; i < 16; i++) await bridge.handle({ id: `old-${i}`, method: 'input', title: 'Old', timeout: 1 })
  await assert.rejects(bridge.handle({ id: 'overflow', method: 'input', title: 'Too many' }))
  for (const resolve of resolvers) resolve({ action: 'cancel' })
  await new Promise(resolve => setImmediate(resolve))
  await bridge.handle({ id: 'new', method: 'input', title: 'New', timeout: 1 })
})

test('Host withdrawal response releases the original ACP request; old accepted value never reaches Pi', async () => {
  const resolvers = new Map<string, (value: CreateElicitationResponse) => void>()
  const replies: unknown[] = []
  const conn = {
    unstable_createElicitation: (request: CreateElicitationRequest) =>
      new Promise<CreateElicitationResponse>(resolve => {
        const id = (request._meta?.farfoldPi as { event: { id: string } }).event.id
        resolvers.set(id, resolve)
      }),
    extNotification: async (_method: string, params: Record<string, unknown>) => {
      const id = params.nativeRequestId as string
      const resolve = resolvers.get(id)
      assert.ok(resolve)
      resolve({ action: 'accept', content: { value: 'late old answer' } })
      resolvers.delete(id)
    }
  }
  const bridge = new PiUiBridge('native-a', conn, async reply => {
    replies.push(reply)
  })
  for (let i = 0; i < 20; i++) await bridge.handle({ id: `request-${i}`, method: 'input', title: 'Timed', timeout: 1 })
  assert.equal(resolvers.size, 0)
  assert.equal(replies.length, 20)
  assert.ok(replies.every(reply => (reply as { cancelled: boolean }).cancelled === true))
})

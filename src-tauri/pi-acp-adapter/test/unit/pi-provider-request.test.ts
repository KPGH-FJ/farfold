import assert from 'node:assert/strict'
import test from 'node:test'
import { providerRequestFromMessage } from '../../src/acp/pi-provider-request.js'

test('Provider receipt requires a fresh complete native assistant result and excludes private fields', () => {
  const startedAt = Date.now() - 1
  const message = {
    role: 'assistant',
    provider: 'provider',
    model: 'model',
    stopReason: 'stop',
    timestamp: Date.now(),
    errorMessage: 'private',
    content: [{ text: 'private' }]
  }
  const receipt = providerRequestFromMessage('host-turn', 'native', startedAt, message)
  assert.equal(receipt?.hostTurnId, 'host-turn')
  assert.equal(receipt?.runtimeProviderId, 'provider')
  assert.equal(receipt?.runtimeModelId, 'provider/model')
  assert.equal(receipt?.nativeModelId, 'model')
  assert.equal(JSON.stringify(receipt).includes('private'), false)
  for (const patch of [
    { role: 'user' },
    { provider: '' },
    { model: '' },
    { timestamp: startedAt - 1 },
    { timestamp: Date.now() + 100000 },
    { timestamp: 0.5 },
    { stopReason: 'aborted' },
    { stopReason: 'toolUse' },
    { stopReason: ['stop'] }
  ])
    assert.equal(providerRequestFromMessage('host-turn', 'native', startedAt, { ...message, ...patch }), undefined)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

import { sessionFixture } from '../helpers/session-fixture.js'
const sessionFile = sessionFixture('s1', '/tmp/project')

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile, updatedAt: new Date().toISOString() }
  }
  upsert() {
    // noop
  }
}

test('PiAcpAgent: does not emit startup info on loadSession', async () => {
  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      verifyRestoredModel: async () => {},
      getAvailableModels: async () => ({ models: [] }),
      getAvailableThinkingLevels: async () => ({ levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }),
      getState: async () => ({ sessionId: 's1', sessionFile, thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: { farfoldPi: { version: 1 } } }
    })

    // Inject store so loadSession resolves without depending on actual filesystem.
    ;(agent as any).store = new FakeStore()

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.piAcp?.startupInfo, null)

    // Only available_commands_update should be scheduled.
    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
  }
})

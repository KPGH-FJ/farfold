import type { AgentSideConnection, CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  readonly forms: CreateElicitationRequest[] = []
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  formResponse: CreateElicitationResponse = { action: 'accept', content: { value: '' } }
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    this.forms.push(params)
    return this.formResponse
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, params })
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  readonly interventions: Array<{ type: string; message: string }> = []
  thinkingLevel = 'medium'
  dispose(): void {}
  async verifyRestoredModel(): Promise<void> {}

  async intervene(type: 'steer' | 'follow_up', message: string): Promise<void> {
    this.interventions.push({ type, message })
  }

  async getCommands(): Promise<unknown> {
    return { commands: [] }
  }

  async getAvailableThinkingLevels(): Promise<unknown> {
    return { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingLevel = level
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return { thinkingLevel: this.thinkingLevel }
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}

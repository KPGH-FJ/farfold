import { RequestError, type AgentSideConnection, type CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { PiRpcEvent, PiRpcProcess } from '../pi-rpc/process.js'

export const PI_EXTENSION_VERSION = 1
const dialogs = new Set(['select', 'confirm', 'input', 'editor'])
const notices = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'])

export function supportsPiExtensions(capabilities: unknown): boolean {
  const value = capabilities as {
    elicitation?: { form?: unknown }
    _meta?: { farfoldPi?: { version?: unknown } }
  } | null
  return value?._meta?.farfoldPi?.version === PI_EXTENSION_VERSION && value.elicitation?.form != null
}

type Reply = Parameters<PiRpcProcess['sendExtensionUiResponse']>[0]
type WithdrawalReason = 'cancelled' | 'timeout' | 'connection_closed'

export class PiUiBridge {
  private readonly pending = new Map<string, (reason: WithdrawalReason) => void>()
  private readonly remotePending = new Map<string, Promise<unknown>>()
  private readonly handling = new Set<Promise<void>>()
  private readonly seen = new Set<string>()
  private closed = false
  private onClosed!: () => void
  private readonly closing = new Promise<void>(resolve => {
    this.onClosed = resolve
  })

  constructor(
    private readonly sessionId: string,
    private readonly conn: Pick<AgentSideConnection, 'unstable_createElicitation' | 'extNotification'>,
    private readonly respond: (reply: Reply) => Promise<void>
  ) {}

  get hasPending(): boolean {
    return this.pending.size > 0 || this.remotePending.size > 0 || this.handling.size > 0
  }

  async invalidate(close = false): Promise<void> {
    if (close) {
      this.closed = true
      this.onClosed()
    }
    for (const cancel of this.pending.values()) cancel(close ? 'connection_closed' : 'cancelled')
  }

  async drain(): Promise<void> {
    while (!this.closed && (this.handling.size || this.remotePending.size)) {
      await Promise.race([Promise.all([...this.handling, ...this.remotePending.values()]), this.closing])
    }
  }

  handle(event: PiRpcEvent): Promise<void> {
    const pending = this.handleEvent(event).finally(() => {
      this.handling.delete(pending)
    })
    this.handling.add(pending)
    return pending
  }

  private async handleEvent(event: PiRpcEvent): Promise<void> {
    const { id, method } = event
    if (this.closed) throw RequestError.invalidRequest('Pi UI connection is closed')
    if (typeof id !== 'string' || typeof method !== 'string' || !id || Buffer.byteLength(JSON.stringify(event)) > 65536)
      throw RequestError.invalidParams('Invalid Pi UI envelope')
    if (notices.has(method)) {
      await this.conn.extNotification('_pi/ui', { sessionId: this.sessionId, version: PI_EXTENSION_VERSION, event })
      return
    }
    if (!dialogs.has(method)) throw RequestError.invalidParams('Unsupported Pi RPC UI method')
    if (this.seen.has(id) || this.remotePending.size >= 16 || this.seen.size >= 4096)
      throw RequestError.invalidParams('Duplicate or excessive Pi UI requests')
    if (typeof event.title !== 'string') throw RequestError.invalidParams('Pi dialog title is missing')
    if (
      method === 'select' &&
      (!Array.isArray(event.options) || !event.options.length || !event.options.every(v => typeof v === 'string'))
    )
      throw RequestError.invalidParams('Pi select options are invalid')
    if (
      event.timeout !== undefined &&
      (typeof event.timeout !== 'number' || !Number.isSafeInteger(event.timeout) || event.timeout <= 0)
    )
      throw RequestError.invalidParams('Pi dialog timeout is invalid')

    this.seen.add(id)
    let cancel!: (reason: WithdrawalReason) => void
    let invalidated = false
    let withdrawalReason: WithdrawalReason | undefined
    const cancelled = new Promise<null>(resolve => {
      cancel = reason => {
        invalidated = true
        withdrawalReason ??= reason
        resolve(null)
      }
    })
    this.pending.set(id, cancel)
    const timer =
      typeof event.timeout === 'number'
        ? setTimeout(() => cancel('timeout'), Math.min(event.timeout, 2147483647))
        : undefined
    const property =
      method === 'confirm'
        ? { type: 'boolean' as const, title: event.title }
        : {
            type: 'string' as const,
            title: event.title,
            ...(method === 'select' ? { enum: event.options as string[] } : {}),
            ...(method === 'editor' && typeof event.prefill === 'string' ? { default: event.prefill } : {})
          }
    const request: CreateElicitationRequest = {
      sessionId: this.sessionId,
      mode: 'form',
      message: typeof event.message === 'string' ? event.message : event.title,
      requestedSchema: { type: 'object', properties: { value: property }, required: ['value'] },
      _meta: { sessionId: this.sessionId, farfoldPi: { version: PI_EXTENSION_VERSION, event } }
    }
    try {
      const remote = Promise.resolve()
        .then(() => this.conn.unstable_createElicitation(request))
        .finally(() => {
          this.remotePending.delete(id)
        })
      this.remotePending.set(id, remote)
      const result = await Promise.race([remote, cancelled])
      if (invalidated) {
        // The Host must answer the matching ACP form with cancel, not merely hide its card.
        await this.conn.extNotification('_pi/ui_withdrawn', {
          sessionId: this.sessionId,
          version: PI_EXTENSION_VERSION,
          nativeRequestId: id,
          reason: withdrawalReason
        })
      }
      let reply: Reply = { id, cancelled: true }
      if (!invalidated && result?.action === 'accept') {
        const value = result.content?.value
        if (method === 'confirm' && typeof value === 'boolean') reply = { id, confirmed: value }
        else if (
          method !== 'confirm' &&
          typeof value === 'string' &&
          Buffer.byteLength(value) <= 65536 &&
          (method !== 'select' || (event.options as string[]).includes(value))
        )
          reply = { id, value }
        else throw RequestError.invalidParams('Pi dialog response does not match its schema')
      }
      // Closing destroys the native connection; cancellation while live returns its native sentinel.
      if (!this.closed) await this.respond(reply)
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }
}

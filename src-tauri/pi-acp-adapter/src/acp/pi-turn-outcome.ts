import { RequestError } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../pi-rpc/process.js'

export class PiTurnOutcome {
  private latestStop: string | null = null
  private settled = false
  private extensionIdle = false
  private cancellation: 'none' | 'pending' | 'confirmed' | 'failed' = 'none'

  event(event: PiRpcEvent): void {
    if (event.type === 'agent_settled') this.settled = true
    if (event.type !== 'message_end') return
    const message = event.message as { role?: unknown; stopReason?: unknown } | null
    if (message?.role === 'assistant')
      this.latestStop = typeof message.stopReason === 'string' ? message.stopReason : null
  }

  extensionCompleted(): void {
    this.extensionIdle = true
  }
  cancelling(): void {
    this.cancellation = 'pending'
  }
  cancelled(): void {
    this.cancellation = 'confirmed'
  }
  cancelFailed(): void {
    this.cancellation = 'failed'
  }

  result(): 'end_turn' | 'error' | 'cancelled' | null {
    if (!this.settled && !this.extensionIdle) return null
    if (this.cancellation === 'pending') return null
    if (this.latestStop === 'error') return 'error'
    if (this.latestStop === 'aborted') return 'cancelled'
    if (this.latestStop === 'stop' || this.latestStop === 'length') return 'end_turn'
    if (this.cancellation === 'confirmed') return 'cancelled'
    if (this.extensionIdle && this.cancellation === 'none') return 'end_turn'
    throw RequestError.internalError({ farfoldOutcomeUnknown: true }, 'Pi stopped without a confirmed outcome')
  }
}

export type PiProviderRequest = {
  version: 1
  hostTurnId: string
  sessionId: string
  runtimeProviderId: string
  runtimeModelId: string
  nativeModelId: string
  nativeTimestamp: number
  completedAt: number
  nativeStopReason: 'stop' | 'length' | 'error'
}

// Fixed Pi RPC message_end carries the final AssistantMessage. Do not copy its
// content, error text, headers or usage into the Host's Provider status receipt.
export function providerRequestFromMessage(
  hostTurnId: string,
  sessionId: string,
  startedAt: number,
  value: unknown
): PiProviderRequest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const message = value as Record<string, unknown>
  const completedAt = Date.now()
  if (
    message.role !== 'assistant' ||
    typeof message.provider !== 'string' ||
    !message.provider ||
    message.provider.length > 256 ||
    typeof message.model !== 'string' ||
    !message.model ||
    message.model.length > 512 ||
    typeof message.timestamp !== 'number' ||
    !Number.isSafeInteger(message.timestamp) ||
    message.timestamp < startedAt ||
    message.timestamp > completedAt ||
    typeof message.stopReason !== 'string' ||
    !['stop', 'length', 'error'].includes(message.stopReason)
  )
    return undefined
  return {
    version: 1,
    hostTurnId,
    sessionId,
    runtimeProviderId: message.provider,
    runtimeModelId: `${message.provider}/${message.model}`,
    nativeModelId: message.model,
    nativeTimestamp: message.timestamp,
    completedAt,
    nativeStopReason: message.stopReason as PiProviderRequest['nativeStopReason']
  }
}

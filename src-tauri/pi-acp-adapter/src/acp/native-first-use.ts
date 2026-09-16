export const NATIVE_FIRST_USE_ENTRY = 'farfold-native-first-use-v1'

export type PiNativeFirstUseState =
  | { version: 1; phase: 'authentication_required' | 'model_selection_required' }
  | { version: 1; phase: 'ready'; provider: string; modelId: string }

export function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function validProvider(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes('/') &&
    !hasControlCharacters(value)
  )
}

function validModel(value: unknown, provider: string): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    `${provider}/${value}`.length <= 512 &&
    !hasControlCharacters(value)
  )
}

export function parseNativeFirstUseState(value: unknown): PiNativeFirstUseState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.phase !== 'string') return null
  if (record.phase === 'authentication_required' || record.phase === 'model_selection_required') {
    return Object.keys(record).every(key => key === 'version' || key === 'phase')
      ? { version: 1, phase: record.phase }
      : null
  }
  if (
    record.phase === 'ready' &&
    validProvider(record.provider) &&
    validModel(record.modelId, record.provider) &&
    Object.keys(record).every(key => ['version', 'phase', 'provider', 'modelId'].includes(key))
  ) {
    return { version: 1, phase: 'ready', provider: record.provider, modelId: record.modelId }
  }
  return null
}

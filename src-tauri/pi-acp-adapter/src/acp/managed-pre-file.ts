import { lstatSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { assertPrivateAuthProfile } from './native-auth.js'

// A one-use, profile-scoped ownership receipt, not native history or native first-use state.
// Host hashes the complete stable ownership and bootstrap version into binding.
export type ManagedPreFile = { version: 1; binding: string; provider: string; modelId: string }

export function parseManagedPreFile(value: unknown): ManagedPreFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (
    v.version !== 1 ||
    typeof v.binding !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.binding) ||
    typeof v.provider !== 'string' ||
    !v.provider ||
    v.provider.includes('/') ||
    v.provider.length > 200 ||
    typeof v.modelId !== 'string' ||
    !v.modelId ||
    (v.provider + '/' + v.modelId).length > 512 ||
    Object.keys(v).some(key => !['version', 'binding', 'provider', 'modelId'].includes(key))
  )
    return null
  return { version: 1, binding: v.binding, provider: v.provider, modelId: v.modelId }
}

export function managedPreFileAnchor(): ManagedPreFile | null {
  const raw = process.env.FARFOLD_PI_MANAGED_PRE_FILE
  if (raw === undefined) return null
  const parsed = parseManagedPreFile(JSON.parse(raw))
  if (!parsed) throw new Error('Invalid managed pre-file ownership')
  return parsed
}

export function requireManagedPreFile(receipt: ManagedPreFile, sessionFile: string): void {
  const anchor = managedPreFileAnchor()
  if (!anchor || JSON.stringify(anchor) !== JSON.stringify(parseManagedPreFile(receipt)))
    throw new Error('Managed pre-file ownership or bootstrap version changed')
  const agent = process.env.PI_CODING_AGENT_DIR
  if (!agent) throw new Error('Managed pre-file profile is missing')
  assertPrivateAuthProfile(agent)
  const root = realpathSync(resolve(agent, '..', 'sessions'))
  const parent = realpathSync(dirname(sessionFile))
  if (parent !== root && !parent.startsWith(root + sep)) throw new Error('Managed pre-file path is outside its profile')
  // lstat distinguishes absent from symlink, unreadable, and already-persisted history.
  try {
    lstatSync(sessionFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('Managed pre-file identity already has a native file')
}

export function verifyEmptyManagedState(state: any, messages: any, models: any, receipt: ManagedPreFile): void {
  if (
    state?.isStreaming !== false ||
    state?.isCompacting !== false ||
    state?.pendingMessageCount !== 0 ||
    state?.model?.provider !== receipt.provider ||
    state?.model?.id !== receipt.modelId ||
    !Array.isArray(messages?.messages) ||
    messages.messages.length !== 0 ||
    !Array.isArray(models?.models) ||
    !models.models.some((m: any) => m.provider === receipt.provider && m.id === receipt.modelId)
  )
    throw new Error('Managed pre-file session is not empty, idle, or on its exact bootstrap model')
}

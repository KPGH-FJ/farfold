import { join } from 'node:path'
import { getAgentDir } from './pi-settings.js'

/**
 * Storage owned by the ACP adapter.
 *
 * Adapter references are separate from native history, but scoped to the same profile.
 */
export function getPiAcpDir(): string {
  return join(getAgentDir(), 'farfold-acp')
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function sessionFixture(sessionId: string, cwd: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'pi-acp-identity-')), 'session.jsonl')
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd }) + '\n')
  return file
}

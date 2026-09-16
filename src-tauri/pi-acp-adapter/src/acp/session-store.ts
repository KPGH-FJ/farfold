import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getPiAcpSessionMapPath } from './paths.js'
import { parseNativeFirstUseState, type PiNativeFirstUseState } from './native-first-use.js'
import { parseManagedPreFile, type ManagedPreFile } from './managed-pre-file.js'

export type StoredSession = {
  sessionId: string
  cwd: string
  sessionFile: string
  updatedAt: string
  nativeFirstUse?: PiNativeFirstUseState
  managedPreFile?: ManagedPreFile
}

type SessionMapFile = {
  version: 1
  sessions: Record<string, StoredSession>
}

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true })
}

function loadFile(path: string): SessionMapFile {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as SessionMapFile
    if (
      parsed?.version !== 1 ||
      typeof parsed.sessions !== 'object' ||
      !parsed.sessions ||
      Array.isArray(parsed.sessions)
    ) {
      throw new Error('Invalid session map')
    }
    for (const [id, entry] of Object.entries(parsed.sessions)) {
      if (
        !entry ||
        entry.sessionId !== id ||
        !id.trim() ||
        typeof entry.cwd !== 'string' ||
        !isAbsolute(entry.cwd) ||
        typeof entry.sessionFile !== 'string' ||
        !isAbsolute(entry.sessionFile) ||
        typeof entry.updatedAt !== 'string' ||
        (entry.nativeFirstUse !== undefined && !parseNativeFirstUseState(entry.nativeFirstUse)) ||
        (entry.managedPreFile !== undefined &&
          (!parseManagedPreFile(entry.managedPreFile) || entry.nativeFirstUse !== undefined))
      ) {
        throw new Error('Invalid session reference')
      }
    }
    return parsed
  } catch {
    throw new Error('Pi ACP session references are corrupt; existing references were not overwritten')
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } catch (saveError) {
    try {
      unlinkSync(temporary)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AggregateError(
          [saveError, cleanupError],
          'Pi ACP session references could not be saved or cleaned up'
        )
      }
    }
    throw saveError
  }
}

export class SessionStore {
  private readonly path: string

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path)
    return Object.hasOwn(db.sessions, sessionId) ? db.sessions[sessionId] : null
  }

  upsert(entry: {
    sessionId: string
    cwd: string
    sessionFile: string
    nativeFirstUse?: PiNativeFirstUseState
    managedPreFile?: ManagedPreFile | null
  }): void {
    const db = loadFile(this.path)
    const previous = db.sessions[entry.sessionId]
    Object.defineProperty(db.sessions, entry.sessionId, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        sessionFile: entry.sessionFile,
        updatedAt: new Date().toISOString(),
        ...((entry.managedPreFile === null ? null : (entry.managedPreFile ?? previous?.managedPreFile))
          ? { managedPreFile: entry.managedPreFile ?? previous?.managedPreFile }
          : {}),
        ...((entry.nativeFirstUse ?? previous?.nativeFirstUse)
          ? { nativeFirstUse: entry.nativeFirstUse ?? previous?.nativeFirstUse }
          : {})
      }
    })
    saveFile(this.path, db)
  }

  setNativeFirstUse(sessionId: string, state: PiNativeFirstUseState): void {
    const current = this.get(sessionId)
    if (!current) throw new Error('Pi ACP native first-use session reference is missing')
    this.upsert({ ...current, nativeFirstUse: state })
  }

  consumeManagedPreFile(sessionId: string): void {
    const current = this.get(sessionId)
    if (current?.managedPreFile) this.upsert({ ...current, managedPreFile: null })
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path)
    if (!db.sessions[sessionId]) return
    delete db.sessions[sessionId]
    saveFile(this.path, db)
  }
}

import { RequestError } from '@agentclientprotocol/sdk'
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export type NativeSessionIdentity = { sessionId: string; sessionFile: string }

export function readNativeIdentity(state: unknown): NativeSessionIdentity {
  const value = state as Partial<NativeSessionIdentity> | null
  if (
    typeof value?.sessionId !== 'string' ||
    !value.sessionId.trim() ||
    typeof value.sessionFile !== 'string' ||
    !isAbsolute(value.sessionFile)
  ) {
    throw RequestError.internalError({}, 'Pi did not return a persistent native session identity')
  }
  return { sessionId: value.sessionId, sessionFile: value.sessionFile }
}

export function nativeSessionDescriptor(
  state: unknown,
  expected: NativeSessionIdentity & { cwd: string }
): NativeSessionIdentity & { cwd: string; version: 1 } {
  const actual = readNativeIdentity(state)
  if (actual.sessionId !== expected.sessionId || resolve(actual.sessionFile) !== resolve(expected.sessionFile)) {
    throw RequestError.internalError({}, 'Pi changed its bound native session identity')
  }
  if (!isAbsolute(expected.cwd)) throw RequestError.internalError({}, 'Pi session cwd is not absolute')
  return { version: 1, ...actual, cwd: expected.cwd }
}

export function assertSessionCwd(expected: string, requested: string): void {
  if (!isAbsolute(expected) || !isAbsolute(requested) || resolve(expected) !== resolve(requested)) {
    throw RequestError.invalidParams('The requested cwd does not match the bound Pi session')
  }
}

export function assertSessionFile(identity: NativeSessionIdentity & { cwd: string }): void {
  let fd: number | undefined
  try {
    if (!isAbsolute(identity.sessionFile)) throw new Error('Non-absolute session file')
    fd = openSync(identity.sessionFile, 'r')
    if (!fstatSync(fd).isFile()) throw new Error('Not a session file')
    const buffer = Buffer.alloc(64 * 1024)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, length).toString('utf8')
    const newline = head.indexOf('\n')
    if (newline < 0 && length === buffer.length) throw new Error('Session header too large')
    const header: unknown = JSON.parse(newline < 0 ? head : head.slice(0, newline))
    const value = header as { type?: unknown; id?: unknown; cwd?: unknown } | null
    if (value?.type !== 'session' || value.id !== identity.sessionId || typeof value.cwd !== 'string') {
      throw new Error('Session header identity mismatch')
    }
    assertSessionCwd(identity.cwd, value.cwd)
  } catch {
    throw RequestError.invalidParams('The bound Pi session file is missing, unreadable, or has a different identity')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function assertRestoredIdentity(state: unknown, expected: NativeSessionIdentity): void {
  const actual = readNativeIdentity(state)
  if (
    actual.sessionId !== expected.sessionId ||
    realpathSync(actual.sessionFile) !== realpathSync(expected.sessionFile)
  ) {
    throw RequestError.internalError({}, 'Pi restored a different native session; the connection was closed')
  }
}

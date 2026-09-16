import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { loadPiSdk } from '../pi-rpc/sdk.js'

const text = z.string().max(8192)
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
const providerId = id.refine(value => !value.startsWith('farfold-managed-'))
const url = z
  .string()
  .max(8192)
  .url()
  .refine(value => {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
  })
const promptSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), message: text, placeholder: text.optional() }),
  z.object({ type: z.literal('secret'), message: text, placeholder: text.optional() }),
  z.object({ type: z.literal('manual_code'), message: text, placeholder: text.optional() }),
  z.object({
    type: z.literal('select'),
    message: text,
    options: z
      .array(
        z.object({
          id: text.min(1),
          label: text,
          description: text.optional()
        })
      )
      .min(1)
      .max(128)
  })
])
const noticeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('info'),
    message: text,
    links: z
      .array(z.object({ url, label: text.optional() }))
      .max(16)
      .optional()
  }),
  z.object({ type: z.literal('progress'), message: text }),
  z.object({ type: z.literal('auth_url'), url, instructions: text.optional() }),
  z.object({
    type: z.literal('device_code'),
    userCode: text,
    verificationUri: url,
    intervalSeconds: z.number().finite().positive().optional(),
    expiresInSeconds: z.number().finite().positive().optional()
  })
])
export const nativeAuthCommand = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      sessionId: id,
      providerId,
      authType: z.enum(['api_key', 'oauth']),
      operation: z.enum(['login', 'logout']).default('login')
    })
    .strict(),
  z.object({ action: z.literal('status'), sessionId: id, flowId: id }).strict(),
  z.object({ action: z.literal('cancel'), sessionId: id, flowId: id }).strict(),
  z
    .object({ action: z.literal('reply'), sessionId: id, flowId: id, promptId: id, value: z.string().max(65536) })
    .strict()
])

type Prompt = z.infer<typeof promptSchema>
type Notice = z.infer<typeof noticeSchema>
type Interaction = {
  signal: AbortSignal
  prompt(value: Prompt & { signal?: AbortSignal }): Promise<string>
  notify(value: Notice): void
}
export type NativeAuthRuntime = {
  getProvider(id: string): { auth?: { apiKey?: { login?: unknown }; oauth?: { login?: unknown } } } | undefined
  getProviders?(): ReadonlyArray<{
    id: string
    name: string
    auth?: {
      apiKey?: { name: string; login?: unknown }
      oauth?: { name: string; login?: unknown }
    }
  }>
  login(provider: string, type: 'api_key' | 'oauth', interaction: Interaction): Promise<unknown>
  logout?(provider: string, options: { signal: AbortSignal }): Promise<void>
  listCredentials?(options: {
    signal: AbortSignal
  }): Promise<ReadonlyArray<{ providerId: string; type: 'api_key' | 'oauth' }>>
}

export async function readNativeAuthCatalog(root: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const { runtime } = await createNativeAuthBackend(root, controller.signal)
    controller.signal.throwIfAborted()
    if (!runtime.getProviders) throw new Error()
    const providers = runtime.getProviders().filter(provider => providerId.safeParse(provider.id).success)
    if (!runtime.listCredentials) throw new Error()
    const credentials = z
      .array(z.object({ providerId: id, type: z.enum(['api_key', 'oauth']) }))
      .max(1024)
      .parse(await runtime.listCredentials({ signal: controller.signal }))
    controller.signal.throwIfAborted()
    if (providers.length > 512) throw new Error()
    return {
      providers: providers
        .map(provider => ({
          id: provider.id,
          name: text.parse(provider.name),
          credentialType: credentials.find(credential => credential.providerId === provider.id)?.type ?? null,
          methods: [
            ...(typeof provider.auth?.apiKey?.login === 'function'
              ? [{ type: 'api_key', name: text.parse(provider.auth.apiKey.name) }]
              : []),
            ...(typeof provider.auth?.oauth?.login === 'function'
              ? [{ type: 'oauth', name: text.parse(provider.auth.oauth.name) }]
              : [])
          ]
        }))
        .filter(provider => provider.methods.length > 0 || provider.credentialType !== null)
    }
  } catch {
    throw new Error('Pi native authentication catalog is unavailable')
  } finally {
    clearTimeout(timer)
  }
}
export type NativeAuthBackend = {
  runtime: NativeAuthRuntime
  synchronizedCredentialError(error: unknown): boolean
}
type AuthSnapshot = {
  version: 1
  sessionId: string
  flowId: string
  providerId: string
  authType: 'api_key' | 'oauth'
  operation: 'login' | 'logout'
  state: 'running' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed' | 'unknown'
  credentialState: 'not_attempted' | 'committed' | 'unknown'
  refreshState: 'not_attempted' | 'confirmed' | 'unknown'
  prompt: { id: string; value: Prompt } | null
  notice: Notice | null
}
type Flow = {
  snapshot: AuthSnapshot
  controller: AbortController
  pending: { id: string; resolve(value: string): void; reject(): void } | null
  settled: boolean
  timer: ReturnType<typeof setTimeout>
}

// SDK auth defaults must never reach the user's global profile. The Host supplies this owned root.
export function assertPrivateAuthProfile(root: string): void {
  if (!isAbsolute(root)) throw new Error('Pi authentication requires an owned profile')
  for (let path = root; path !== dirname(path); path = dirname(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Pi authentication profile is unsafe')
    if (path === root && (stat.mode & 0o077) !== 0) throw new Error('Pi authentication profile is not private')
  }
  for (const name of ['auth.json', 'models.json', 'models-store.json']) {
    let fd: number | undefined
    try {
      fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024)
        throw new Error('Pi authentication profile file is unsafe')
      const content = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < content.length) {
        const count = readSync(fd, content, offset, content.length - offset, offset)
        if (!count) throw new Error()
        offset += count
      }
      const after = fstatSync(fd)
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
        throw new Error()
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
      if (name === 'auth.json' && Object.keys(data).some(key => key.startsWith('farfold-managed-')))
        throw new Error('Pi managed credentials cannot be shadowed by native authentication')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw new Error('Pi authentication profile file is unavailable or unsafe')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

export async function createNativeAuthBackend(
  root: string,
  signal: AbortSignal,
  sdkLoader = loadPiSdk
): Promise<NativeAuthBackend> {
  assertPrivateAuthProfile(root)
  const sdk = await sdkLoader()
  signal.throwIfAborted()
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(root, 'auth.json'),
    modelsPath: join(root, 'models.json'),
    modelsStorePath: join(root, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal
  })
  return {
    runtime,
    synchronizedCredentialError: error =>
      typeof sdk.CredentialSynchronizationError === 'function' && error instanceof sdk.CredentialSynchronizationError
  }
}

// Only explicit request responses expose these ephemeral snapshots; never emit ACP session events.
export class PiNativeAuth {
  private flow: Flow | null = null
  private disposed = false

  constructor(private readonly createBackend = createNativeAuthBackend) {}

  get blocksWork(): boolean {
    return (
      this.flow !== null &&
      (!this.flow.settled ||
        this.flow.snapshot.state === 'unknown' ||
        (this.flow.snapshot.credentialState === 'committed' && this.flow.snapshot.refreshState !== 'confirmed'))
    )
  }

  start(
    input: { sessionId: string; providerId: string; authType: 'api_key' | 'oauth'; operation?: 'login' | 'logout' },
    hooks: {
      root: string
      prepare(signal: AbortSignal): Promise<void>
      refresh(signal: AbortSignal): Promise<void>
      finish(blocked: boolean): void
    }
  ): AuthSnapshot {
    if (this.disposed || this.blocksWork) throw new Error('Pi authentication is already active or unresolved')
    const controller = new AbortController()
    const flow: Flow = {
      snapshot: {
        version: 1,
        sessionId: input.sessionId,
        providerId: input.providerId,
        authType: input.authType,
        operation: input.operation ?? 'login',
        flowId: randomUUID(),
        state: 'running',
        credentialState: 'not_attempted',
        refreshState: 'not_attempted',
        prompt: null,
        notice: null
      },
      controller,
      pending: null,
      settled: false,
      timer: setTimeout(() => this.cancel(input.sessionId, flow.snapshot.flowId), 10 * 60 * 1000)
    }
    flow.timer.unref()
    this.flow = flow
    void this.run(flow, hooks)
    return this.status(input.sessionId, flow.snapshot.flowId)
  }

  private async run(
    flow: Flow,
    hooks: {
      root: string
      prepare(signal: AbortSignal): Promise<void>
      refresh(signal: AbortSignal): Promise<void>
      finish(blocked: boolean): void
    }
  ) {
    let backend: NativeAuthBackend | undefined
    try {
      const signal = flow.controller.signal
      await prepareUntilCancelled(hooks.prepare, signal)
      signal.throwIfAborted()
      backend = await this.createBackend(hooks.root, signal)
      signal.throwIfAborted()
      const provider = backend.runtime.getProvider(flow.snapshot.providerId)
      const method = flow.snapshot.authType === 'oauth' ? provider?.auth?.oauth : provider?.auth?.apiKey
      if (flow.snapshot.operation === 'login' && typeof method?.login !== 'function')
        throw new Error('Pi native authentication method is unavailable')
      if (flow.snapshot.operation === 'logout' && typeof backend.runtime.logout !== 'function')
        throw new Error('Pi native logout is unavailable')
      // From this point cancellation/error alone cannot prove that credentials were not committed.
      flow.snapshot.credentialState = 'unknown'
      if (flow.snapshot.operation === 'logout') await backend.runtime.logout!(flow.snapshot.providerId, { signal })
      else
        await backend.runtime.login(flow.snapshot.providerId, flow.snapshot.authType, {
          signal,
          prompt: value => this.prompt(flow, value),
          notify: value => {
            if (signal.aborted || flow.settled || this.disposed) return
            flow.snapshot.notice = noticeSchema.parse(value)
          }
        })
      flow.snapshot.credentialState = 'committed'
      signal.throwIfAborted()
      flow.snapshot.refreshState = 'unknown'
      await hooks.refresh(signal)
      signal.throwIfAborted()
      flow.snapshot.refreshState = 'confirmed'
      flow.snapshot.state = 'succeeded'
    } catch (error) {
      if (backend?.synchronizedCredentialError(error)) flow.snapshot.credentialState = 'committed'
      flow.snapshot.state =
        flow.snapshot.credentialState === 'not_attempted'
          ? flow.controller.signal.aborted
            ? 'cancelled'
            : 'failed'
          : 'unknown'
      // SDK error/cause/credential and rejected prompt values deliberately never cross this boundary.
    } finally {
      flow.pending?.reject()
      flow.pending = null
      flow.snapshot.prompt = null
      flow.snapshot.notice = null
      flow.settled = true
      clearTimeout(flow.timer)
      hooks.finish(this.blocksWork)
    }
  }

  private prompt(flow: Flow, value: Prompt & { signal?: AbortSignal }): Promise<string> {
    if (this.disposed || flow.settled || flow.pending || flow.controller.signal.aborted || value.signal?.aborted)
      return Promise.reject(new Error('Pi authentication prompt is unavailable'))
    const parsed = promptSchema.parse(value)
    const promptId = randomUUID()
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        flow.controller.signal.removeEventListener('abort', cancel)
        value.signal?.removeEventListener('abort', cancel)
        if (flow.pending?.id === promptId) {
          flow.pending = null
          flow.snapshot.prompt = null
        }
      }
      const cancel = () => {
        cleanup()
        reject(new Error('Pi authentication prompt was cancelled'))
      }
      flow.pending = {
        id: promptId,
        resolve: answer => {
          cleanup()
          resolve(answer)
        },
        reject: cancel
      }
      flow.snapshot.prompt = { id: promptId, value: parsed }
      flow.controller.signal.addEventListener('abort', cancel, { once: true })
      value.signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  private target(sessionId: string, flowId: string): Flow {
    if (
      this.disposed ||
      !this.flow ||
      this.flow.snapshot.sessionId !== sessionId ||
      this.flow.snapshot.flowId !== flowId
    )
      throw new Error('Pi authentication identity is stale')
    return this.flow
  }

  status(sessionId: string, flowId: string): AuthSnapshot {
    return structuredClone(this.target(sessionId, flowId).snapshot)
  }

  reply(sessionId: string, flowId: string, promptId: string, value: string): AuthSnapshot {
    const flow = this.target(sessionId, flowId)
    if (flow.controller.signal.aborted || !flow.pending || flow.pending.id !== promptId || value.length > 65536)
      throw new Error('Pi authentication response is stale or invalid')
    const prompt = flow.snapshot.prompt?.value
    if (prompt?.type === 'select' && !prompt.options.some(option => option.id === value))
      throw new Error('Pi authentication selection is invalid')
    flow.pending.resolve(value)
    return this.status(sessionId, flowId)
  }

  cancel(sessionId: string, flowId: string): AuthSnapshot {
    const flow = this.target(sessionId, flowId)
    if (!flow.settled) {
      flow.snapshot.state = 'cancelling'
      flow.snapshot.notice = null
      flow.controller.abort()
    }
    return this.status(sessionId, flowId)
  }

  dispose(): void {
    this.disposed = true
    if (this.flow) {
      clearTimeout(this.flow.timer)
      this.flow.controller.abort()
      this.flow.snapshot.prompt = null
      this.flow.snapshot.notice = null
    }
  }

  cancelSession(sessionId: string): void {
    if (!this.disposed && this.flow?.snapshot.sessionId === sessionId && !this.flow.settled)
      this.cancel(sessionId, this.flow.snapshot.flowId)
  }
}

async function prepareUntilCancelled(
  prepare: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const preparation = new AbortController()
  const forwardAbort = () => preparation.abort()
  signal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => preparation.abort(), 15000)
  let cancel!: () => void
  try {
    await Promise.race([
      prepare(preparation.signal),
      new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('Pi authentication preparation was cancelled'))
        preparation.signal.addEventListener('abort', cancel, { once: true })
        if (preparation.signal.aborted) cancel()
      })
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
    preparation.signal.removeEventListener('abort', cancel)
    preparation.abort()
  }
}

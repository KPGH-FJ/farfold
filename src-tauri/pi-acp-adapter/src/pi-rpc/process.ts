import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import { randomBytes } from 'node:crypto'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import { createProfileExtension, type ProfileExtension } from './profile-extension.js'
import { PiModelRestoreMismatchError, prepareRestoreSource, type PiRestoreSource } from './restore-source.js'
import { parseNativeFirstUseState, type PiNativeFirstUseState } from '../acp/native-first-use.js'
export { PiModelRestoreMismatchError } from './restore-source.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'steer' | 'follow_up'; id?: string; message: string }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  | { type: 'get_entries'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  { id: string; value: string } | { id: string; confirmed: boolean } | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  sessionId?: string
  nativeFirstUse?: PiNativeFirstUseState
  preFileModel?: { provider: string; modelId: string }
}

export class PiRpcRejectedError extends Error {}
export class PiPromptNotSentError extends PiRpcRejectedError {}

export type PiPromptModel = {
  sessionId: string
  sessionFile: string
  provider: string
  modelId: string
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    string,
    {
      resolve: (v: PiRpcResponse) => void
      reject: (e: unknown) => void
      mutating: boolean
      command: PiRpcCommand['type']
    }
  >()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private failure: Error | null = null
  private refreshingProfile = false
  private authentication: symbol | null = null
  private profileFinished: Promise<void> | null = null
  private uiResponseWrites = 0
  private profileAcknowledgement: ((value: unknown) => void) | null = null
  private promptPreparation: { cancelled: boolean; finished: Promise<void> } | null = null

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly profileExtension: ProfileExtension,
    private readonly restoreSource?: PiRestoreSource,
    private readonly initialNativeFirstUse?: PiNativeFirstUseState
  ) {
    this.child = child

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      if (
        msg?.type === 'extension_ui_request' &&
        msg.method === 'notify' &&
        typeof msg.message === 'string' &&
        msg.message.startsWith(this.profileExtension.prefix)
      ) {
        let acknowledgement: unknown
        try {
          if (msg.message.length <= 8192)
            acknowledgement = JSON.parse(msg.message.slice(this.profileExtension.prefix.length))
        } catch {
          /* A malformed private acknowledgement is not a user notification. */
        }
        this.profileAcknowledgement?.(acknowledgement)
        return
      }
      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    rl.on('close', () => this.fail(new Error('Pi RPC output closed')))
    child.on('exit', (code, signal) => this.fail(new Error(`pi process exited (code=${code}, signal=${signal})`)))
    child.on('error', err => this.fail(err))
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const handler of this.eventHandlers) handler({ type: 'pi_acp_transport_closed' })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    const trust = process.env.FARFOLD_PI_PROJECT_TRUST
    if (trust === 'approve') args.push('--approve')
    else if (trust === 'ignore') args.push('--no-approve')
    else if (trust !== undefined && trust !== 'saved') throw new PiRpcSpawnError('Invalid Pi project trust choice')
    let restoreSource: PiRestoreSource | undefined
    if (params.sessionPath) {
      if (!params.sessionId) throw new PiModelRestoreMismatchError('history_unavailable')
      restoreSource = await prepareRestoreSource({
        sessionId: params.sessionId,
        sessionFile: params.sessionPath,
        cwd: params.cwd
      })
      args.push('--session', params.sessionPath)
      if (restoreSource.model && (!restoreSource.nativeFirstUse || restoreSource.nativeFirstUse.phase === 'ready'))
        args.push('--provider', restoreSource.model.provider, '--model', restoreSource.model.modelId)
    } else if (params.sessionId && (params.nativeFirstUse || params.preFileModel)) {
      args.push('--session-id', params.sessionId)
      if (params.preFileModel)
        args.push('--provider', params.preFileModel.provider, '--model', params.preFileModel.modelId)
      else if (params.nativeFirstUse?.phase === 'ready')
        args.push('--provider', params.nativeFirstUse.provider, '--model', params.nativeFirstUse.modelId)
    }
    const profileExtension = createProfileExtension(restoreSource?.leafId)
    args.push('--extension', profileExtension.path)

    try {
      restoreSource?.assertUnchanged()
    } catch (error) {
      profileExtension.dispose()
      throw error
    }
    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd)
    })

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      profileExtension.dispose()
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    child.stderr.on('data', () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    child.once('exit', () => profileExtension.dispose())
    const proc = new PiRpcProcess(child, profileExtension, restoreSource, params.nativeFirstUse)

    // The caller must verify native get_state identity before registering this process.
    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    if (this.failure) handler({ type: 'pi_acp_transport_closed' })
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(
    message: string,
    images: unknown[] = [],
    expectedModel?: PiPromptModel,
    canDispatch: () => boolean = () => true
  ): Promise<void> {
    const res = await this.dispatchModelCommand({ type: 'prompt', message, images }, expectedModel, canDispatch)
    if (!res.success) throw new PiRpcRejectedError('Pi prompt was rejected')
  }

  private async dispatchModelCommand(
    command: Extract<PiRpcCommand, { type: 'prompt' | 'compact' }>,
    expectedModel?: PiPromptModel,
    canDispatch: () => boolean = () => true
  ): Promise<PiRpcResponse> {
    if (expectedModel) {
      if (
        this.promptPreparation ||
        this.authentication ||
        this.refreshingProfile ||
        this.uiResponseWrites ||
        [...this.pending.values()].some(request => request.mutating)
      )
        throw new PiPromptNotSentError('Pi model preflight requires an idle connection')
      let finish!: () => void
      const preparation = {
        cancelled: false,
        finished: new Promise<void>(resolve => {
          finish = resolve
        })
      }
      this.promptPreparation = preparation
      let timer: ReturnType<typeof setTimeout> | undefined
      let dispatched: Promise<PiRpcResponse>
      try {
        const state = (await Promise.race([
          this.getState(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new PiPromptNotSentError('Pi model preflight timed out')), 15000)
          })
        ])) as
          | {
              sessionId?: string
              sessionFile?: string
              model?: { provider?: string; id?: string }
              isStreaming?: boolean
              isCompacting?: boolean
              pendingMessageCount?: number
            }
          | undefined
        if (
          preparation.cancelled ||
          this.failure ||
          this.uiResponseWrites ||
          !canDispatch() ||
          state?.sessionId !== expectedModel.sessionId ||
          state?.sessionFile !== expectedModel.sessionFile ||
          state?.model?.provider !== expectedModel.provider ||
          state?.model?.id !== expectedModel.modelId ||
          state?.isStreaming !== false ||
          state?.isCompacting !== false ||
          state?.pendingMessageCount !== 0
        )
          throw new PiPromptNotSentError('Pi model or idle session changed before dispatch')
        // The same mutation guard covers the fresh native read through the synchronous RPC write.
        dispatched = this.request(command, 'prompt')
      } catch {
        throw new PiPromptNotSentError('Pi model preflight did not authorize a prompt')
      } finally {
        clearTimeout(timer)
        this.promptPreparation = null
        finish()
      }
      let res: PiRpcResponse
      try {
        res = await dispatched
        if (res.success !== true && res.success !== false) throw new Error('Malformed prompt acknowledgement')
      } catch {
        this.fail(new Error('Pi prompt acknowledgement is unknown'))
        throw new Error('Pi prompt acknowledgement is unknown')
      }
      return res
    }
    return this.request(command)
  }

  async abort(): Promise<void> {
    if (this.promptPreparation) this.promptPreparation.cancelled = true
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async intervene(type: 'steer' | 'follow_up', message: string): Promise<void> {
    const response = await this.request({ type, message })
    if (response.success === false) throw new PiRpcRejectedError(`Pi ${type} was rejected`)
    if (response.success !== true) throw new Error('Pi intervention acknowledgement is malformed')
  }

  async getAvailableThinkingLevels(): Promise<unknown> {
    const response = await this.request({ type: 'get_available_thinking_levels' })
    if (!response.success) throw new Error('Pi thinking-level query was rejected')
    return response.data
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(
    customInstructions?: string,
    expectedModel?: PiPromptModel,
    canDispatch: () => boolean = () => true
  ): Promise<unknown> {
    const res = await this.dispatchModelCommand({ type: 'compact', customInstructions }, expectedModel, canDispatch)
    if (res.success !== true) throw new PiRpcRejectedError('Pi compaction was rejected')
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getEntries(): Promise<unknown> {
    const res = await this.request({ type: 'get_entries' })
    if (!res.success) throw new Error('Pi entries query was rejected')
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data as { commands?: Array<{ name?: string }> } | undefined
    if (!Array.isArray(data?.commands)) return res.data
    return {
      ...data,
      commands: data.commands.filter(
        command =>
          command.name !== this.profileExtension?.command &&
          command.name !== this.profileExtension?.restoreCommand &&
          command.name !== this.profileExtension?.firstUseCommand
      )
    }
  }

  get isRefreshingProfile(): boolean {
    return this.refreshingProfile
  }

  beginAuthentication(): {
    refresh(): Promise<void>
    recordNativeFirstUse(state: PiNativeFirstUseState): Promise<void>
    release(): void
  } {
    if (
      this.failure ||
      this.authentication ||
      this.refreshingProfile ||
      this.promptPreparation ||
      this.uiResponseWrites ||
      [...this.pending.values()].some(request => request.mutating)
    )
      throw new PiRpcRejectedError('Pi authentication requires an idle connection')
    const token = Symbol('authentication')
    this.authentication = token
    return {
      refresh: () => this.runProfileCommand('refresh', token),
      recordNativeFirstUse: state => this.runProfileCommand('first_use', token, state),
      release: () => {
        if (this.authentication === token) this.authentication = null
      }
    }
  }

  async refreshProfile(): Promise<void> {
    await this.runProfileCommand('refresh')
  }

  async verifyRestoredModel(): Promise<void> {
    await this.runProfileCommand('restore')
  }

  get restoredNativeFirstUse(): PiNativeFirstUseState | null {
    return this.restoreSource?.nativeFirstUse ?? this.initialNativeFirstUse ?? null
  }

  async recordNativeFirstUse(state: PiNativeFirstUseState): Promise<void> {
    await this.runProfileCommand('first_use', undefined, state)
  }

  private async runProfileCommand(
    kind: 'refresh' | 'restore' | 'first_use',
    authToken?: symbol,
    firstUse?: PiNativeFirstUseState
  ): Promise<void> {
    if (
      (this.authentication !== null && this.authentication !== authToken) ||
      this.refreshingProfile ||
      this.promptPreparation ||
      this.uiResponseWrites ||
      [...this.pending.values()].some(request => request.mutating)
    )
      throw new PiRpcRejectedError('Pi profile refresh requires an idle connection')
    this.refreshingProfile = true
    let finishProfile!: () => void
    this.profileFinished = new Promise(resolve => {
      finishProfile = resolve
    })
    let dispatched = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const operation = async () => {
        const before = (await this.getState()) as Record<string, unknown>
        if (
          !before ||
          before.isStreaming !== false ||
          before.isCompacting !== false ||
          before.pendingMessageCount !== 0
        )
          throw new PiRpcRejectedError('Pi profile refresh requires an idle native session')
        if (
          typeof before.sessionId !== 'string' ||
          !before.sessionId ||
          typeof before.sessionFile !== 'string' ||
          !before.sessionFile
        )
          throw new PiRpcRejectedError('Pi profile refresh requires a persisted native identity')
        const commands = await this.request({ type: 'get_commands' })
        const data = commands.data as
          { commands?: Array<{ name?: string; source?: string; sourceInfo?: { path?: string } }> } | undefined
        const commandName =
          kind === 'refresh'
            ? this.profileExtension.command
            : kind === 'restore'
              ? this.profileExtension.restoreCommand
              : this.profileExtension.firstUseCommand
        const matches = data?.commands?.filter(command => command.name === commandName)
        if (
          commands.success !== true ||
          matches?.length !== 1 ||
          matches[0].source !== 'extension' ||
          matches[0].sourceInfo?.path !== this.profileExtension.path
        )
          throw new PiRpcRejectedError('The owned Pi profile extension is not registered')
        const nonce = randomBytes(24).toString('hex')
        const acknowledgement = new Promise<unknown>(resolve => {
          this.profileAcknowledgement = resolve
        })
        dispatched = true
        const encodedFirstUse =
          kind === 'first_use' && firstUse
            ? ` ${Buffer.from(JSON.stringify(firstUse), 'utf8').toString('base64url')}`
            : ''
        const response = await this.request(
          { type: 'prompt', message: `/${commandName} ${nonce}${encodedFirstUse}` },
          'profile'
        )
        if (response.success !== true) throw new Error('Pi profile refresh was not acknowledged')
        const ack = (await acknowledgement) as
          | {
              nonce?: string
              success?: boolean
              before?: Record<string, unknown>
              after?: Record<string, unknown>
              operation?: string
              failureReason?: string
              originalLeafRetained?: boolean
              restoredModel?: { provider?: unknown; modelId?: unknown } | null
              currentModel?: { provider?: unknown; modelId?: unknown } | null
              firstUse?: unknown
            }
          | undefined
        if (ack?.nonce !== nonce || typeof ack.success !== 'boolean' || !ack.before || !ack.after)
          throw new Error('Pi profile refresh acknowledgement is invalid')
        for (const identity of [ack.before, ack.after]) {
          if (
            identity.pid !== this.child.pid ||
            identity.sessionId !== before.sessionId ||
            identity.sessionFile !== before.sessionFile
          )
            throw new Error('Pi profile refresh changed native identity')
        }
        const after = (await this.getState()) as Record<string, unknown>
        if (
          !after ||
          after.sessionId !== before.sessionId ||
          after.sessionFile !== before.sessionFile ||
          after.isStreaming !== false ||
          after.isCompacting !== false ||
          after.pendingMessageCount !== 0
        )
          throw new Error('Pi profile refresh did not preserve native idle identity')
        if (kind === 'first_use') {
          const recorded = parseNativeFirstUseState(ack.firstUse)
          if (
            ack.operation !== 'first_use' ||
            !ack.success ||
            !firstUse ||
            !recorded ||
            JSON.stringify(recorded) !== JSON.stringify(firstUse)
          )
            throw new Error('Pi native first-use acknowledgement is invalid')
        } else if (kind === 'restore') {
          if (ack.operation !== 'restore') throw new Error('Pi restore observation acknowledgement is invalid')
          if (!ack.success) {
            if (ack.failureReason !== 'parser_unavailable' && ack.failureReason !== 'history_unavailable')
              throw new Error('Pi restore failure acknowledgement is invalid')
            throw new PiModelRestoreMismatchError(ack.failureReason)
          }
          const restoredFirstUse = parseNativeFirstUseState(ack.firstUse)
          const expectedFirstUse = this.restoreSource?.nativeFirstUse ?? null
          if (
            JSON.stringify(restoredFirstUse) !== JSON.stringify(expectedFirstUse) ||
            (expectedFirstUse && ack.originalLeafRetained !== true)
          )
            throw new PiModelRestoreMismatchError('history_unavailable')
          if (expectedFirstUse && expectedFirstUse.phase !== 'ready') {
            this.restoreSource?.assertUnchanged(true)
            return
          }
          const restored = ack.restoredModel
          const current = ack.currentModel
          const beforeModel = before.model as { provider?: unknown; id?: unknown } | undefined
          const afterModel = after.model as { provider?: unknown; id?: unknown } | undefined
          const original = this.restoreSource?.model
          if (original && ack.originalLeafRetained !== true)
            throw new PiModelRestoreMismatchError('history_unavailable')
          if (
            !restored ||
            typeof restored.provider !== 'string' ||
            !restored.provider ||
            restored.provider.length > 200 ||
            restored.provider.includes('/') ||
            typeof restored.modelId !== 'string' ||
            !restored.modelId ||
            `${restored.provider}/${restored.modelId}`.length > 512 ||
            (original && (restored.provider !== original.provider || restored.modelId !== original.modelId)) ||
            current?.provider !== restored.provider ||
            current?.modelId !== restored.modelId ||
            beforeModel?.provider !== restored.provider ||
            beforeModel?.id !== restored.modelId ||
            afterModel?.provider !== restored.provider ||
            afterModel?.id !== restored.modelId
          )
            throw new PiModelRestoreMismatchError()
          this.restoreSource?.assertUnchanged(true)
        } else if (!ack.success) throw new Error('Pi profile refresh acknowledgement is invalid')
      }
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Pi profile refresh timed out')), 15000)
        })
      ])
    } catch (error) {
      if (error instanceof PiModelRestoreMismatchError) throw error
      if (!dispatched && error instanceof PiRpcRejectedError) throw error
      // A lost acknowledgement cannot authorize subsequent prompts on potentially changed state.
      this.fail(new Error('Pi profile refresh outcome is unknown'))
      this.dispose()
      throw new Error('Pi profile refresh outcome is unknown')
    } finally {
      clearTimeout(timer)
      this.profileAcknowledgement = null
      this.refreshingProfile = false
      this.profileFinished = null
      finishProfile()
    }
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    if (this.authentication) throw new PiRpcRejectedError('Pi authentication is active or unresolved')
    this.uiResponseWrites++
    try {
      // Preserve a valid late answer, but do not interleave it with a native profile mutation.
      if (this.profileFinished) await this.profileFinished
      if (this.promptPreparation) await this.promptPreparation.finished
      if (this.failure) throw new Error('Pi UI response connection is closed')
      await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
    } finally {
      this.uiResponseWrites--
    }
  }

  private request(cmd: PiRpcCommand, ownedControl?: 'profile' | 'prompt'): Promise<PiRpcResponse> {
    if (this.failure) return Promise.reject(this.failure)
    if (
      [...this.pending.values()].some(request => request.command === 'compact') &&
      !cmd.type.startsWith('get_') &&
      cmd.type !== 'abort'
    )
      return Promise.reject(new PiRpcRejectedError('Pi manual compaction is active'))
    if (this.authentication && ownedControl !== 'profile' && !cmd.type.startsWith('get_') && cmd.type !== 'abort')
      return Promise.reject(new PiRpcRejectedError('Pi authentication is active or unresolved'))
    if (this.refreshingProfile && ownedControl !== 'profile' && !cmd.type.startsWith('get_') && cmd.type !== 'abort')
      return Promise.reject(new PiRpcRejectedError('Pi profile refresh is active'))
    if (this.promptPreparation && ownedControl !== 'prompt' && !cmd.type.startsWith('get_') && cmd.type !== 'abort')
      return Promise.reject(new PiRpcRejectedError('Pi model preflight is active'))
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, mutating: !cmd.type.startsWith('get_'), command: cmd.type })

      void this.writeLine(line).catch(error => {
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }
}

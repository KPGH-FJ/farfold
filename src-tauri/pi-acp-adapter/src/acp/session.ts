import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  PiPromptNotSentError,
  PiRpcRejectedError,
  type PiPromptModel,
  type PiRpcEvent
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToText } from './translate/pi-tools.js'
import { PiUiBridge } from './pi-ui.js'
import { PiTurnOutcome } from './pi-turn-outcome.js'
import { readNativeIdentity } from './session-identity.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  nativeEvents?: boolean
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PromptDispatch = {
  message: string
  images: unknown[]
  expectedModel?: PiPromptModel
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  activeSessions(): PiAcpSession[] {
    return [...this.sessions.values()]
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.dispose()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Pi owns persistence inside the launch profile supplied by the Host.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let identity: ReturnType<typeof readNativeIdentity>
    try {
      identity = readNativeIdentity(await proc.getState())
      if (this.sessions.has(identity.sessionId)) {
        throw RequestError.internalError({}, 'Pi returned an already bound native session ID')
      }
      this.store.upsert({ ...identity, cwd: params.cwd })
    } catch (error) {
      proc.dispose()
      throw error
    }
    const { sessionId } = identity

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      nativeEvents: params.nativeEvents,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      nativeEvents: params.nativeEvents,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]
  private readonly ui: PiUiBridge
  private connectionFailed = false

  get isUsable(): boolean {
    return !this.connectionFailed
  }

  get hasActiveTurn(): boolean {
    return this.pendingTurn !== null
  }

  get canCancel(): boolean {
    return !this.manualCompaction
  }

  get hasPendingUi(): boolean {
    return this.ui.hasPending
  }

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Pi owns steering and follow-up queues; the adapter accepts one ordinary prompt.
  private pendingTurn: PendingTurn | null = null
  private manualCompaction = false
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false
  private nativeAgentStarted = false
  private outcome = new PiTurnOutcome()

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    nativeEvents?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.nativeEvents = opts.nativeEvents === true
    this.ui = new PiUiBridge(this.sessionId, this.conn, reply => this.proc.sendExtensionUiResponse(reply))

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  dispose(): void {
    this.failConnection()
    this.proc.dispose()
  }

  private failConnection(): void {
    this.connectionFailed = true
    void this.ui.invalidate(true)
    const error = RequestError.internalError(
      { farfoldOutcomeUnknown: true },
      'Pi connection closed; task result is unknown'
    )
    this.pendingTurn?.reject(error)
    this.pendingTurn = null
  }

  async intervene(kind: 'steer' | 'follow_up', message: string): Promise<void> {
    if (this.connectionFailed || !this.pendingTurn || this.cancelRequested || this.manualCompaction)
      throw RequestError.invalidRequest('Pi intervention requires a live active task')
    if (!message.trim() || Buffer.byteLength(message) > 65536)
      throw RequestError.invalidParams('Pi intervention text is empty or too large')
    await this.proc.intervene(kind, message)
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = [], expectedModel?: PiPromptModel): Promise<StopReason> {
    if (this.connectionFailed) throw RequestError.invalidRequest('Pi connection must be reopened')
    if (this.pendingTurn)
      throw RequestError.invalidRequest('Pi is busy; use the negotiated native intervention methods')
    const expandedMessage = expandSlashCommand(message, this.fileCommands)
    return new Promise<StopReason>((resolve, reject) => {
      this.startTurn({ message: expandedMessage, images, expectedModel, resolve, reject })
    })
  }

  async cancel(): Promise<'accepted' | 'unsupported'> {
    // Fixed Pi 0.84.3 RPC abort does not cancel manual compaction. The flag is
    // claimed synchronously, before preflight, closing the prompt/Stop race.
    if (this.manualCompaction) return 'unsupported'
    this.cancelRequested = true
    this.outcome.cancelling()
    await this.ui.invalidate()
    try {
      await this.proc.abort()
      this.outcome.cancelled()
      if (this.pendingTurn) await this.finishTurn(this.pendingTurn)
      return 'accepted'
    } catch (error) {
      this.outcome.cancelFailed()
      this.failConnection()
      throw error
    }
  }

  async compact(customInstructions?: string, expectedModel?: PiPromptModel): Promise<StopReason> {
    if (this.connectionFailed || this.pendingTurn || this.hasPendingUi)
      throw RequestError.invalidRequest({ farfoldPiPromptNotSent: true }, 'Pi compaction requires an idle session')
    this.manualCompaction = true
    this.cancelRequested = false
    this.outcome = new PiTurnOutcome()
    let resolve!: PendingTurn['resolve']
    let reject!: PendingTurn['reject']
    const completion = new Promise<StopReason>((done, fail) => {
      resolve = done
      reject = fail
    })
    // Avoid an unhandled rejection if the transport closes during native I/O.
    void completion.catch(() => {})
    const pending = { resolve, reject }
    this.pendingTurn = pending
    let ended: PiRpcEvent | undefined
    const unsubscribe = this.proc.onEvent(event => {
      if (event.type === 'compaction_end' && event.reason === 'manual') ended = event
    })
    this.emit({ sessionUpdate: 'session_info_update', _meta: { farfoldPi: { version: 1, running: true } } })
    try {
      let data: unknown
      let nativeRejected = false
      try {
        data = await this.proc.compact(
          customInstructions,
          expectedModel,
          () => this.pendingTurn === pending && !this.connectionFailed && !this.hasPendingUi
        )
      } catch (error) {
        if (error instanceof PiPromptNotSentError)
          throw RequestError.invalidRequest(
            { farfoldPiPromptNotSent: true },
            'Pi model preflight rejected compaction before native dispatch'
          )
        if (!(error instanceof PiRpcRejectedError)) throw error
        nativeRejected = true
      }
      const state = (await this.proc.getState()) as Record<string, any>
      if (
        this.pendingTurn !== pending ||
        !ended ||
        ended.willRetry !== false ||
        state?.sessionId !== this.sessionId ||
        state.isStreaming !== false ||
        state.isCompacting !== false ||
        state.pendingMessageCount !== 0 ||
        (expectedModel &&
          (state.sessionFile !== expectedModel.sessionFile ||
            state.model?.provider !== expectedModel.provider ||
            state.model?.id !== expectedModel.modelId))
      )
        throw new Error('Pi compaction settlement is unknown')
      const result = data as { summary?: unknown; firstKeptEntryId?: unknown } | undefined
      let reason: StopReason
      if (
        !nativeRejected &&
        ended.aborted === false &&
        !ended.errorMessage &&
        typeof result?.summary === 'string' &&
        typeof result.firstKeptEntryId === 'string' &&
        JSON.stringify(ended.result) === JSON.stringify(data)
      ) {
        reason = 'end_turn'
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Compaction completed.\n\n${result.summary}` }
        })
      } else if (nativeRejected && ended.aborted === true) reason = 'cancelled'
      else if (nativeRejected && ended.aborted === false && typeof ended.errorMessage === 'string') reason = 'error'
      else throw new Error('Pi compaction result is unknown')
      await this.ui.drain()
      await this.flushEmits()
      if (this.pendingTurn !== pending) throw new Error('Pi compaction connection changed')
      pending.resolve(reason)
    } catch (error) {
      if (
        error instanceof RequestError &&
        (error.data as Record<string, unknown> | undefined)?.farfoldPiPromptNotSent === true
      )
        pending.reject(error)
      else {
        pending.reject(RequestError.internalError({ farfoldOutcomeUnknown: true }, 'Pi compaction result is unknown'))
        this.failConnection()
      }
    } finally {
      unsubscribe()
      if (this.pendingTurn === pending) this.pendingTurn = null
      this.manualCompaction = false
      this.emit({ sessionUpdate: 'session_info_update', _meta: { farfoldPi: { version: 1, running: false } } })
    }
    return completion
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: PromptDispatch): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.nativeAgentStarted = false
    this.outcome = new PiTurnOutcome()

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { farfoldPi: { version: 1, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    const pending = this.pendingTurn
    this.proc
      .prompt(
        t.message,
        t.images,
        t.expectedModel,
        () => this.pendingTurn === pending && !this.cancelRequested && !this.hasPendingUi && !this.connectionFailed
      )
      .then(async () => {
        if (!t.message.startsWith('/') || this.nativeAgentStarted || this.pendingTurn !== pending) return
        const commands = (await this.proc.getCommands()) as { commands?: Array<{ name?: string; source?: string }> }
        const name = t.message.slice(1).split(/\s/, 1)[0]
        if (!commands.commands?.some(command => command.name === name && command.source === 'extension')) return
        const state = (await this.proc.getState()) as {
          isStreaming?: boolean
          isCompacting?: boolean
          pendingMessageCount?: number
        }
        if (
          this.pendingTurn === pending &&
          !this.nativeAgentStarted &&
          state.isStreaming === false &&
          state.isCompacting === false &&
          state.pendingMessageCount === 0
        ) {
          this.outcome.extensionCompleted()
          await this.finishTurn(pending)
        }
      })
      .catch(err => {
        // If the subprocess errors before we get `agent_settled`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        void this.flushEmits().finally(() => {
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          if (this.pendingTurn !== pending) return
          const authErr = err instanceof PiPromptNotSentError ? null : maybeAuthRequiredError(err)
          if (err instanceof PiPromptNotSentError) {
            this.pendingTurn?.reject(
              RequestError.invalidRequest(
                { farfoldPiPromptNotSent: true },
                'Pi model preflight rejected this prompt before native dispatch'
              )
            )
          } else if (authErr) {
            this.pendingTurn?.reject(authErr)
          } else {
            this.pendingTurn?.resolve('error')
          }

          this.pendingTurn = null
          this.inAgentLoop = false

          // If the prompt failed, do not automatically proceed—pi may be unhealthy.
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { farfoldPi: { version: 1, running: false } }
          })
        })
        void err
      })
  }

  private async finishTurn(expected: PendingTurn): Promise<void> {
    if (this.manualCompaction) return
    await this.flushEmits()
    if (this.pendingTurn !== expected) return
    let reason: StopReason | null
    try {
      reason = this.outcome.result()
      if (reason === null) return
      // A native timeout can finish before the Host answers its withdrawn ACP form.
      await this.ui.drain()
      await this.flushEmits()
      if (this.pendingTurn !== expected) return
      reason = this.outcome.result()
    } catch (error) {
      expected.reject(error)
      this.failConnection()
      return
    }
    if (reason === null) return
    expected.resolve(reason)
    this.pendingTurn = null
    this.inAgentLoop = false
    this.emit({ sessionUpdate: 'session_info_update', _meta: { farfoldPi: { version: 1, running: false } } })
  }

  private readonly nativeEvents: boolean

  private handlePiEvent(ev: PiRpcEvent) {
    if (this.nativeEvents && !this.connectionFailed) {
      const event = structuredClone(ev)
      this.lastEmit = this.lastEmit
        .then(() =>
          this.conn.extNotification('_pi/event', {
            version: 1,
            sessionId: this.sessionId,
            event
          })
        )
        .catch(() => this.failConnection())
    }
    this.outcome.event(ev)
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.ui.handle(ev).catch(() => this.failConnection())
        break
      }

      case 'pi_acp_transport_closed': {
        this.failConnection()
        break
      }

      case 'queue_update': {
        this.emit({ sessionUpdate: 'session_info_update', _meta: { farfoldPi: { version: 1, event: ev } } })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        this.nativeAgentStarted = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        if (this.pendingTurn) void this.finishTurn(this.pendingTurn)
        break
      }

      default:
        break
    }
  }
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}

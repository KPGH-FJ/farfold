import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type DeleteSessionRequest,
  type DeleteSessionResponse
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import { PiNativeAuth, nativeAuthCommand, assertPrivateAuthProfile, readNativeAuthCatalog } from './native-auth.js'
import { PiRpcRejectedError, PiModelRestoreMismatchError } from '../pi-rpc/process.js'
import { SessionManager, type PiAcpSession } from './session.js'
import { PI_EXTENSION_VERSION, supportsPiExtensions } from './pi-ui.js'
import { SessionStore } from './session-store.js'
import {
  assertRestoredIdentity,
  assertSessionCwd,
  assertSessionFile,
  nativeSessionDescriptor,
  readNativeIdentity
} from './session-identity.js'
import { PiRpcProcess } from '../pi-rpc/process.js'
import { listPiSessions, findPiSession } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { promptToPiMessage } from './translate/prompt.js'
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import { toAvailableCommandsFromPiGetCommands } from './pi-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { providerRequestFromMessage, type PiProviderRequest } from './pi-provider-request.js'
import { parsePromptModel } from './pi-prompt-model.js'
import type { PiNativeFirstUseState } from './native-first-use.js'
import {
  managedPreFileAnchor,
  requireManagedPreFile,
  verifyEmptyManagedState,
  type ManagedPreFile
} from './managed-pre-file.js'
import { isAbsolute } from 'node:path'
import { existsSync, readFileSync, realpathSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}
import pkg from '../../package.json' with { type: 'json' }

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly restoringSessions = new Map<string, Promise<PiAcpSession>>()
  private readonly replayingSessions = new Set<string>()
  private readonly nativeFirstUse = new Map<string, PiNativeFirstUseState>()
  private creatingSessions = 0
  private piExtensions = false
  private readonly nativeAuth = new PiNativeAuth()

  dispose(): void {
    this.nativeAuth.dispose()
    this.nativeFirstUse.clear()
    this.sessions.disposeAll()
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    void _config
  }

  private cleanupFailedNewSession(sessionId: string): void {
    this.nativeFirstUse.delete(sessionId)
    this.sessions.close(sessionId)
    // A failed startup does not authorize deleting Pi-owned history or extension writes.
    this.store.delete(sessionId)
  }

  private findStoredSession(sessionId: string): {
    cwd: string
    sessionFile: string
    nativeFirstUse?: PiNativeFirstUseState
    managedPreFile?: ManagedPreFile
  } | null {
    const stored = this.store.get(sessionId)
    if (stored?.cwd && stored?.sessionFile) {
      return {
        cwd: stored.cwd,
        sessionFile: stored.sessionFile,
        ...(stored.managedPreFile ? { managedPreFile: stored.managedPreFile } : {}),
        ...(stored.nativeFirstUse ? { nativeFirstUse: stored.nativeFirstUse } : {})
      }
    }

    const piSession = findPiSession(sessionId)
    if (!piSession) return null

    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    })

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    }
  }

  private async describeSession(session: PiAcpSession) {
    const stored = this.store.get(session.sessionId)
    if (!stored) throw RequestError.internalError({}, 'Pi native session binding is missing')
    assertSessionCwd(stored.cwd, session.cwd)
    return nativeSessionDescriptor(await session.proc.getState(), { ...stored, sessionId: session.sessionId })
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers']; fromReplay?: boolean }
  ): Promise<PiAcpSession> {
    this.requirePiExtensions()
    this.assertNotAuthenticating()
    if (!opts?.fromReplay) this.assertNotReplaying(sessionId)
    const existing = this.sessions.maybeGet(sessionId)
    if (existing) {
      if (opts?.cwd) assertSessionCwd(existing.cwd, opts.cwd)
      if (existing.isUsable) return existing
    }

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) {
      const session = await inFlight
      if (opts?.cwd) assertSessionCwd(session.cwd, opts.cwd)
      return session
    }

    const restorePromise = (async () => {
      const stored = this.findStoredSession(sessionId)
      if (!stored) {
        throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
      }

      const cwd = stored.cwd
      if (opts?.cwd) assertSessionCwd(cwd, opts.cwd)
      const persisted = existsSync(stored.sessionFile)
      if (persisted) assertSessionFile({ sessionId, ...stored })
      else if (stored.managedPreFile) requireManagedPreFile(stored.managedPreFile, stored.sessionFile)
      else if (!stored.nativeFirstUse) {
        throw RequestError.invalidParams('The bound Pi session file is missing and has no pending first-use identity')
      }
      if (existing) this.sessions.close(sessionId)

      let proc: PiRpcProcess
      try {
        proc = await PiRpcProcess.spawn({
          cwd,
          sessionId,
          ...(persisted
            ? { sessionPath: stored.sessionFile }
            : stored.managedPreFile
              ? { preFileModel: { provider: stored.managedPreFile.provider, modelId: stored.managedPreFile.modelId } }
              : { nativeFirstUse: stored.nativeFirstUse }),
          piCommand: process.env.PI_ACP_PI_COMMAND
        })
      } catch (e: any) {
        if (e instanceof PiModelRestoreMismatchError)
          throw RequestError.invalidRequest(
            { farfoldPiRestoreBlocked: true, reason: e.reason },
            'Pi original session model could not be restored; no replacement model was accepted'
          )
        if (e?.name === 'PiRpcSpawnError') {
          throw RequestError.internalError({ code: e?.code }, String(e?.message ?? e))
        }
        throw e
      }

      try {
        const state = await proc.getState()
        const identity = readNativeIdentity(state)
        if (identity.sessionId !== sessionId) throw new Error('Pi restored a different native session identity')
        if (persisted) {
          assertRestoredIdentity(state, { sessionId, sessionFile: stored.sessionFile })
          await proc.verifyRestoredModel()
        } else if (stored.managedPreFile) {
          requireManagedPreFile(stored.managedPreFile, stored.sessionFile)
          requireManagedPreFile(stored.managedPreFile, identity.sessionFile)
          verifyEmptyManagedState(
            state,
            await proc.getMessages(),
            await proc.getAvailableModels(),
            stored.managedPreFile
          )
        } else {
          const firstUse = stored.nativeFirstUse!
          if (firstUse.phase === 'ready') {
            const current = (state as { model?: { provider?: unknown; id?: unknown } }).model
            const models = (await proc.getAvailableModels()) as {
              models?: Array<{ provider?: unknown; id?: unknown }>
            }
            if (
              current?.provider !== firstUse.provider ||
              current.id !== firstUse.modelId ||
              !models.models?.some(model => model.provider === firstUse.provider && model.id === firstUse.modelId)
            )
              throw new Error('Pi did not restore the exact native first-use model')
          }
          await proc.recordNativeFirstUse(firstUse)
        }
        const firstUse = proc.restoredNativeFirstUse
        if (persisted && stored.nativeFirstUse && JSON.stringify(firstUse) !== JSON.stringify(stored.nativeFirstUse))
          throw new Error('Pi native first-use reference disagrees with native history')
        if (firstUse) this.nativeFirstUse.set(sessionId, firstUse)
        else this.nativeFirstUse.delete(sessionId)
        if (persisted) assertSessionFile({ sessionId, ...stored })
        this.store.upsert({
          sessionId,
          cwd,
          sessionFile: identity.sessionFile,
          ...(stored.managedPreFile ? { managedPreFile: persisted ? null : stored.managedPreFile } : {}),
          ...(firstUse ? { nativeFirstUse: firstUse } : {})
        })
      } catch (error) {
        proc.dispose()
        if (error instanceof PiModelRestoreMismatchError)
          throw RequestError.invalidRequest(
            { farfoldPiRestoreBlocked: true, reason: error.reason },
            'Pi original session model could not be restored; no replacement model was accepted'
          )
        if (error instanceof RequestError) throw error
        throw RequestError.internalError({}, error instanceof Error ? error.message : 'Pi session restore failed')
      }

      const fileCommands = loadSlashCommands(cwd)
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc,
        fileCommands,
        nativeEvents: this.piExtensions
      })

      this.lastSessionCwd = cwd
      return session
    })()

    this.restoringSessions.set(sessionId, restorePromise)

    try {
      return await restorePromise
    } finally {
      this.restoringSessions.delete(sessionId)
    }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.piExtensions = supportsPiExtensions(params.clientCapabilities)
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        _meta: {
          farfoldPi: {
            version: PI_EXTENSION_VERSION,
            ui: this.piExtensions,
            intervention: this.piExtensions,
            workspace: this.piExtensions,
            profileRefresh: this.piExtensions,
            nativeAuth: this.piExtensions,
            promptModel: this.piExtensions,
            nativeEvents: this.piExtensions
          }
        },
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {}
        }
      }
    }
  }

  async newSession(params: NewSessionRequest) {
    this.requirePiExtensions()
    this.assertNotAuthenticating()
    this.creatingSessions++
    try {
      return await this.createNativeSession(params)
    } finally {
      this.creatingSessions--
    }
  }

  private async createNativeSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }
    const allowUnauthenticated =
      (params._meta?.farfoldPi as Record<string, unknown> | undefined)?.allowUnauthenticated === true
    if (allowUnauthenticated) {
      try {
        const root = process.env.PI_CODING_AGENT_DIR
        if (!root) throw new Error()
        assertPrivateAuthProfile(root)
      } catch {
        throw RequestError.invalidParams('Unauthenticated Pi startup requires an explicit private profile')
      }
    }

    this.lastSessionCwd = params.cwd

    const fileCommands = loadSlashCommands(params.cwd)
    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      nativeEvents: this.piExtensions
    })

    // Fetch state + models once (parallel) to reduce startup latency.
    let state: any = null
    let availableModels: any = null
    let stateErr: unknown = null
    let availableModelsErr: unknown = null

    await Promise.all([
      session.proc
        .getState()
        .then(s => {
          state = s as any
        })
        .catch(err => {
          stateErr = err
          state = null
        }),
      session.proc
        .getAvailableModels()
        .then(m => {
          availableModels = m as any
        })
        .catch(err => {
          availableModelsErr = err
          availableModels = null
        })
    ])

    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId)
      throw availableModelsAuthErr
    }

    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId)
      throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
    }

    // If pi has no models available after spawning, it's effectively unauthenticated.
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

    if (rawModelsCount === 0 && !allowUnauthenticated) {
      this.cleanupFailedNewSession(session.sessionId)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }

    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId)
      throw RequestError.authRequired(
        { authMethods: getAuthMethods() },
        'Configure an API key or log in with an OAuth provider.'
      )
    }
    if (stateErr) {
      this.cleanupFailedNewSession(session.sessionId)
      throw RequestError.internalError({}, 'Pi initial state could not be confirmed')
    }
    let nativeFirstUse: PiNativeFirstUseState | null = null
    if (allowUnauthenticated) {
      nativeFirstUse = {
        version: 1,
        phase: rawModelsCount === 0 ? 'authentication_required' : 'model_selection_required'
      }
      await session.proc.recordNativeFirstUse(nativeFirstUse)
      this.nativeFirstUse.set(session.sessionId, nativeFirstUse)
      this.store.setNativeFirstUse(session.sessionId, nativeFirstUse)
    }
    if (!allowUnauthenticated) {
      const anchor = managedPreFileAnchor()
      if (anchor) {
        try {
          const identity = readNativeIdentity(state)
          requireManagedPreFile(anchor, identity.sessionFile)
          verifyEmptyManagedState(state, await session.proc.getMessages(), availableModels, anchor)
          this.store.upsert({
            sessionId: session.sessionId,
            cwd: params.cwd,
            sessionFile: identity.sessionFile,
            managedPreFile: anchor
          })
        } catch (error) {
          this.cleanupFailedNewSession(session.sessionId)
          throw error
        }
      }
    }

    const { configOptions, models, modes } = await getSessionConfiguration(session.proc, {
      state,
      availableModels
    })

    const quietStartup = getQuietStartup(params.cwd)
    const updateNotice = buildUpdateNotice()

    // If quietStartup is enabled, suppress the full "startup info" prelude, but still surface
    // the "New version available" notice (if any) since it's high-signal and actionable.
    const preludeText = quietStartup
      ? updateNotice
        ? updateNotice + '\n'
        : ''
      : buildStartupInfo({
          cwd: params.cwd,
          fileCommands,
          updateNotice
        })

    if (preludeText) session.setStartupInfo(preludeText)

    let nativeSession: Awaited<ReturnType<PiAcpAgent['describeSession']>>
    try {
      nativeSession = await this.describeSession(session)
    } catch (error) {
      this.cleanupFailedNewSession(session.sessionId)
      throw error
    }

    const response = {
      sessionId: session.sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        farfoldPi: {
          version: PI_EXTENSION_VERSION,
          nativeSession,
          modelSelectionRequired: nativeFirstUse !== null,
          ...(nativeFirstUse ? { nativeFirstUse } : {}),
          ...(this.store.get(session.sessionId)?.managedPreFile
            ? { managedPreFile: this.store.get(session.sessionId)!.managedPreFile }
            : {})
        },
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    }

    // Try to send it immediately after session/new returns; if the client ignores it,
    // it will still be emitted as the first chunk of the first prompt.
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await session.proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // Fall back to file-based prompt templates (legacy behavior).
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  private requirePiExtensions(): void {
    if (!this.piExtensions) throw RequestError.invalidRequest('Pi requires form elicitation and farfoldPi version 1')
  }

  private assertNotAuthenticating(): void {
    if (this.nativeAuth.blocksWork) throw RequestError.invalidRequest('Pi authentication is active or unresolved')
  }

  private nativeAuthRequest(params: Record<string, unknown>): Record<string, unknown> {
    const parsed = nativeAuthCommand.safeParse(params)
    // Zod errors retain rejected inputs. Do not attach them to any ACP error.
    if (!parsed.success) throw RequestError.invalidParams('Pi authentication request is invalid')
    const input = parsed.data
    try {
      if (input.action === 'status') return this.nativeAuth.status(input.sessionId, input.flowId)
      if (input.action === 'cancel') return this.nativeAuth.cancel(input.sessionId, input.flowId)
      if (input.action === 'reply')
        return this.nativeAuth.reply(input.sessionId, input.flowId, input.promptId, input.value)
      this.assertNotAuthenticating()
      if (this.creatingSessions || this.restoringSessions.size || this.replayingSessions.size) throw new Error()
      const root = process.env.PI_CODING_AGENT_DIR
      if (!root || !isAbsolute(root)) throw new Error()
      assertPrivateAuthProfile(root)
      const session = this.sessions.maybeGet(input.sessionId)
      if (!session?.isUsable) throw new Error()
      const sessions = this.sessions.activeSessions()
      const leases: Array<ReturnType<PiRpcProcess['beginAuthentication']>> = []
      const unsubscribers: Array<() => void> = []
      try {
        for (const active of sessions) {
          if (!active.isUsable || active.hasActiveTurn || active.hasPendingUi) throw new Error()
          leases.push(active.proc.beginAuthentication())
        }
        const identities = new Map<PiAcpSession, Awaited<ReturnType<PiAcpAgent['describeSession']>>>()
        const check = async (active: PiAcpSession, signal: AbortSignal) => {
          signal.throwIfAborted()
          if (!active.isUsable || active.hasActiveTurn || active.hasPendingUi) throw new Error()
          const state = (await active.proc.getState()) as Record<string, unknown>
          signal.throwIfAborted()
          if (state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0)
            throw new Error()
          const original = identities.get(active)
          if (original) nativeSessionDescriptor(state, original)
          else identities.set(active, await this.describeSession(active))
          signal.throwIfAborted()
        }
        return this.nativeAuth.start(input, {
          root,
          prepare: async signal => {
            for (const active of sessions) await check(active, signal)
            signal.throwIfAborted()
            for (const active of sessions)
              if (this.store.get(active.sessionId)?.managedPreFile) this.store.consumeManagedPreFile(active.sessionId)
            for (const active of sessions)
              unsubscribers.push(
                active.proc.onEvent(event => {
                  if (
                    event.type === 'pi_acp_transport_closed' ||
                    event.type === 'extension_ui_request' ||
                    event.type === 'agent_start'
                  )
                    this.nativeAuth.cancelSession(input.sessionId)
                })
              )
          },
          refresh: async signal => {
            assertPrivateAuthProfile(root)
            for (let i = 0; i < sessions.length; i++) {
              await check(sessions[i], signal)
              await leases[i].refresh()
              await check(sessions[i], signal)
            }
            if (this.nativeFirstUse.has(input.sessionId)) {
              const next: PiNativeFirstUseState = {
                version: 1,
                phase: input.operation === 'logout' ? 'authentication_required' : 'model_selection_required'
              }
              const index = sessions.indexOf(session)
              if (index < 0) throw new Error()
              await leases[index].recordNativeFirstUse(next)
              this.nativeFirstUse.set(input.sessionId, next)
              this.store.setNativeFirstUse(input.sessionId, next)
            }
            assertPrivateAuthProfile(root)
          },
          finish: blocked => {
            for (const unsubscribe of unsubscribers) unsubscribe()
            if (!blocked) for (const lease of leases) lease.release()
          }
        })
      } catch {
        for (const unsubscribe of unsubscribers) unsubscribe()
        for (const lease of leases) lease.release()
        throw new Error()
      }
    } catch {
      throw RequestError.invalidRequest('Pi authentication request is unavailable, stale or unresolved')
    }
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === '_pi/cancel') {
      if (
        !this.piExtensions ||
        typeof params.sessionId !== 'string' ||
        Object.keys(params).some(key => key !== 'sessionId')
      )
        throw RequestError.invalidParams('Pi cancellation requires the negotiated exact session')
      const session = this.sessions.maybeGet(params.sessionId)
      if (!session?.isUsable) throw RequestError.invalidRequest('Pi cancellation session is not active')
      if (!session.canCancel) return { version: 1, sessionId: session.sessionId, outcome: 'unsupported' }
      // Synchronously claims cancellation before returning acceptance. Native
      // terminal events, not this ACK, settle the Host task. Withdrawal events
      // close any exact pending forms; unknown native failure closes the session.
      void session.cancel().catch(() => {})
      return { version: 1, sessionId: session.sessionId, outcome: 'accepted' }
    }
    this.requirePiExtensions()
    if (method === '_pi/auth') return this.nativeAuthRequest(params)
    if (method !== '_pi/workspace') this.assertNotAuthenticating()
    if (method === '_pi/refresh_profile') {
      if (typeof params.sessionId !== 'string' || Object.keys(params).some(key => key !== 'sessionId'))
        throw RequestError.invalidParams('Pi profile refresh requires only a bound session ID')
      this.assertNotReplaying(params.sessionId)
      const session = this.sessions.maybeGet(params.sessionId)
      if (!session?.isUsable || session.hasActiveTurn || session.hasPendingUi || session.proc.isRefreshingProfile)
        throw RequestError.invalidRequest('Pi profile refresh requires an idle active session')
      try {
        const before = await this.describeSession(session)
        if (session.hasActiveTurn || session.hasPendingUi) throw new PiRpcRejectedError('Pi session became busy')
        if (this.store.get(params.sessionId)?.managedPreFile) this.store.consumeManagedPreFile(params.sessionId)
        await session.proc.refreshProfile()
        const nativeSession = nativeSessionDescriptor(await session.proc.getState(), before)
        return { version: 1, nativeSession }
      } catch (error) {
        if (error instanceof PiRpcRejectedError)
          throw RequestError.invalidRequest('Pi profile refresh was not dispatched')
        throw RequestError.internalError({ farfoldOutcomeUnknown: true }, 'Pi profile refresh outcome is unknown')
      }
    }
    if (method === '_pi/workspace') {
      if (
        typeof params.sessionId !== 'string' ||
        typeof params.section !== 'string' ||
        Object.keys(params).some(key => key !== 'sessionId' && key !== 'section')
      )
        throw RequestError.invalidParams('Pi workspace requires a bound session ID and a read-only section')
      this.assertNotReplaying(params.sessionId)
      const session = this.sessions.maybeGet(params.sessionId)
      if (!session?.isUsable) throw RequestError.invalidParams('Pi workspace session is not active')
      const before = await this.describeSession(session)
      let data: unknown
      switch (params.section) {
        case 'configuration':
          data = (await getSessionConfiguration(session.proc)).configOptions
          break
        case 'auth_catalog': {
          this.assertNotAuthenticating()
          const root = process.env.PI_CODING_AGENT_DIR
          if (!root || session.hasActiveTurn || session.hasPendingUi)
            throw RequestError.invalidRequest('Pi authentication catalog requires an idle owned session')
          try {
            data = await readNativeAuthCatalog(root)
          } catch {
            throw RequestError.invalidRequest('Pi native authentication catalog is unavailable')
          }
          break
        }
        case 'state':
          data = await session.proc.getState()
          break
        case 'messages':
          data = await session.proc.getMessages()
          break
        case 'entries':
          data = await session.proc.getEntries()
          break
        case 'models':
          data = await session.proc.getAvailableModels()
          break
        case 'thinking_levels':
          data = await session.proc.getAvailableThinkingLevels()
          break
        case 'commands':
          data = await session.proc.getCommands()
          break
        case 'stats':
        case 'session_command':
          data = await session.proc.getSessionStats()
          break
        default:
          throw RequestError.invalidParams('Unknown read-only Pi workspace section')
      }
      const nativeSession = nativeSessionDescriptor(await session.proc.getState(), before)
      if (params.section === 'state') nativeSessionDescriptor(data, before)
      if (params.section === 'session_command') await this.emitSessionStats(session, data)
      return { version: 1, nativeSession, section: params.section, data }
    }
    if (method !== '_pi/steer' && method !== '_pi/follow_up') throw RequestError.methodNotFound(method)
    if (typeof params.sessionId !== 'string' || typeof params.message !== 'string')
      throw RequestError.invalidParams('Pi intervention requires a session and message')
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) throw RequestError.invalidParams('Pi intervention session is not active')
    const kind = method === '_pi/steer' ? 'steer' : 'follow_up'
    try {
      await session.intervene(kind, params.message)
    } catch (error) {
      if (error instanceof RequestError) throw error
      if (error instanceof PiRpcRejectedError) throw RequestError.invalidRequest('Pi rejected this intervention')
      throw RequestError.internalError({ farfoldOutcomeUnknown: true }, 'Pi intervention acknowledgement is unknown')
    }
    return { accepted: true, sessionId: session.sessionId, delivery: kind }
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  private async sendControlUpdate(params: Parameters<AgentSideConnection['sessionUpdate']>[0]): Promise<void> {
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      await this.conn.sessionUpdate({
        ...params,
        update: {
          ...update,
          _meta: { ...update._meta, farfoldPi: { version: 1, origin: 'adapter_control', id: crypto.randomUUID() } }
        }
      })
    } else await this.conn.sessionUpdate(params)
  }

  private async emitSessionStats(session: PiAcpSession, stats: any): Promise<void> {
    const lines: string[] = []
    if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
    if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
    if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

    if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

    const t = stats?.tokens
    if (t && typeof t === 'object') {
      const parts: string[] = []
      if (typeof t.input === 'number') parts.push(`in ${t.input}`)
      if (typeof t.output === 'number') parts.push(`out ${t.output}`)
      if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
      if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
      if (typeof t.total === 'number') parts.push(`total ${t.total}`)
      if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
    }

    // Fallback if stats shape changes.
    const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

    await this.sendControlUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    })
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId)
    if (this.nativeFirstUse.get(params.sessionId)?.phase !== 'ready' && this.nativeFirstUse.has(params.sessionId))
      throw RequestError.invalidRequest('Pi requires authentication and explicit model selection before a task')
    this.assertNotReplaying(params.sessionId)
    if (session.proc.isRefreshingProfile)
      throw RequestError.invalidRequest({ farfoldPiPromptNotSent: true }, 'Pi profile refresh is active')
    const hostTurnId = (params._meta?.farfoldPi as Record<string, unknown> | undefined)?.hostTurnId
    if (hostTurnId !== undefined && (typeof hostTurnId !== 'string' || !hostTurnId || hostTurnId.length > 200))
      throw RequestError.invalidParams('Pi Host turn identity is invalid')
    const expectedModel = parsePromptModel(
      (params._meta?.farfoldPi as Record<string, unknown> | undefined)?.expectedModel,
      params.sessionId
    )
    if (expectedModel && (!this.piExtensions || typeof hostTurnId !== 'string'))
      throw RequestError.invalidRequest('Pi model preflight requires a negotiated Host turn')

    const { message, images } = promptToPiMessage(params.prompt)
    if (session.hasActiveTurn) throw RequestError.invalidRequest('Pi already has an active prompt')

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        if (this.store.get(params.sessionId)?.managedPreFile) this.store.consumeManagedPreFile(params.sessionId)
        const customInstructions = args.join(' ').trim() || undefined
        const result = await session.compact(customInstructions, expectedModel)
        if (result === 'error')
          throw RequestError.internalError(
            { farfoldOutcomeUnknown: false, nativeStopReason: 'error' },
            'Pi compaction failed'
          )
        // Native compact has no AssistantMessage model receipt. In particular,
        // an Extension-provided summary must not manufacture Provider verification.
        return { stopReason: result }
      }

      if (cmd === 'session') {
        await this.emitSessionStats(session, await session.proc.getSessionStats())
        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await session.proc.setSessionName(name)
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.steeringMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time')

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()
        const state = (await session.proc.getState()) as any
        const current = String(state?.followUpMode ?? '')

        // If no arg, just report current.
        if (!modeRaw) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await session.proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time')

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await session.proc.getState()) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.sendControlUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await session.proc.exportHtml(outputPath)
          resultPath = result.path
        } catch (e: any) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.sendControlUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        let enabled: boolean | null = null
        if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') enabled = true
        else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') enabled = false

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any
          const current = Boolean(state?.autoCompactionEnabled)
          enabled = !current
        }

        await session.proc.setAutoCompaction(enabled)

        await this.sendControlUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    if (session.hasActiveTurn) throw RequestError.invalidRequest('Pi already has an active prompt')
    // Burn before a native prompt can enter Pi, including unknown dispatch outcomes.
    if (this.store.get(params.sessionId)?.managedPreFile) this.store.consumeManagedPreFile(params.sessionId)
    let receipt: PiProviderRequest | undefined
    const startedAt = Date.now()
    const unsubscribe = session.proc.onEvent(event => {
      if (typeof hostTurnId !== 'string' || event.type !== 'message_end') return
      const nativeMessage = event.message as { role?: unknown } | undefined
      if (nativeMessage?.role === 'assistant')
        receipt = providerRequestFromMessage(hostTurnId, session.sessionId, startedAt, nativeMessage)
    })
    try {
      const result = await session.prompt(message, images, expectedModel)
      if (result === 'error')
        throw RequestError.internalError(
          {
            farfoldOutcomeUnknown: false,
            nativeStopReason: 'error',
            ...(receipt?.nativeStopReason === 'error' ? { farfoldPiProviderRequest: receipt } : {})
          },
          'Pi task failed'
        )
      const stopReason: StopReason = result
      return {
        stopReason,
        ...(result === 'end_turn' && receipt && receipt.nativeStopReason !== 'error'
          ? { _meta: { farfoldPiProviderRequest: receipt } }
          : {})
      }
    } finally {
      unsubscribe()
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.nativeAuth.cancelSession(params.sessionId)
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) return
    await session.cancel()
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const all = listPiSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertNotReplaying(params.sessionId)
    this.replayingSessions.add(params.sessionId)
    try {
      return await this.replaySession(params)
    } finally {
      this.replayingSessions.delete(params.sessionId)
    }
  }

  private assertNotReplaying(sessionId: string): void {
    if (this.replayingSessions.has(sessionId)) {
      throw RequestError.invalidRequest('Pi session history is still being restored; retry after loading completes')
    }
  }

  private async replaySession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }

    this.requirePiExtensions()
    const active = this.sessions.maybeGet(params.sessionId)
    if (active?.hasActiveTurn) {
      throw RequestError.invalidRequest('Cannot replay a Pi session while its task is active')
    }

    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      fromReplay: true
    })
    const proc = session.proc
    const fileCommands = loadSlashCommands(params.cwd)

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any
    const messages = Array.isArray(data?.messages) ? data.messages : []

    for (const m of messages) {
      const role = String(m?.role ?? '')

      if (role === 'user') {
        const text = normalizePiMessageText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'assistant') {
        const text = normalizePiAssistantText(m?.content)
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text }
            }
          })
        }
      }

      if (role === 'toolResult') {
        const toolName = String((m as any)?.toolName ?? 'tool')
        const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
        const isError = Boolean((m as any)?.isError)
        const isBash = isBashTool(toolName)

        if (isBash) {
          const text = bashResultText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: 'execute',
              status: 'completed',
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              _meta: {
                ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          })
          continue
        }

        // Create a synthetic ACP tool call to render historic tool usage.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
            status: 'completed',
            rawInput: null,
            rawOutput: m
          }
        })

        const text = toolResultToText(m)
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: isError ? 'failed' : 'completed',
            content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
            rawOutput: m
          }
        })
      }
    }

    const { configOptions, models, modes } = await getSessionConfiguration(proc)

    let nativeSession: Awaited<ReturnType<PiAcpAgent['describeSession']>>
    try {
      nativeSession = await this.describeSession(session)
    } catch (error) {
      this.sessions.close(session.sessionId)
      throw error
    }

    const nativeFirstUse = this.nativeFirstUse.get(session.sessionId) ?? null
    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        farfoldPi: {
          version: PI_EXTENSION_VERSION,
          nativeSession,
          modelSelectionRequired: nativeFirstUse ? nativeFirstUse.phase !== 'ready' : false,
          ...(nativeFirstUse ? { nativeFirstUse } : {}),
          ...(this.store.get(session.sessionId)?.managedPreFile
            ? { managedPreFile: this.store.get(session.sessionId)!.managedPreFile }
            : {})
        },
        piAcp: {
          startupInfo: null
        }
      }
    }

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void (async () => {
        try {
          const pi = (await proc.getCommands()) as any
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          })

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          })
          return
        } catch {
          // fall back
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        })
      })()
    }, 0)

    return response
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    this.assertNotAuthenticating()
    const stored = this.store.get(params.sessionId)
    const piSession = findPiSession(params.sessionId)

    // Per ACP session/delete semantics, deleting a session that does not
    // exist (or is already gone) should succeed idempotently.
    // https://agentclientprotocol.com/protocol/v2/session-delete#semantics
    if (!stored && !piSession) {
      return {}
    }

    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile

    if (sessionFile) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch {
        // best-effort cleanup
      }
    }

    this.store.delete(params.sessionId)
    this.nativeFirstUse.delete(params.sessionId)

    return {}
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = await this.restoreSession(params.sessionId)
    if (session.hasActiveTurn) throw RequestError.invalidRequest('Pi configuration requires an idle session')
    if (this.store.get(params.sessionId)?.managedPreFile) this.store.consumeManagedPreFile(params.sessionId)
    await setSessionModel(session.proc, params.modelId)
    await this.confirmInitialModelSelection(session, params.modelId)
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.restoreSession(params.sessionId)
    if (session.hasActiveTurn) throw RequestError.invalidRequest('Pi configuration requires an idle session')

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await setNativeThinkingLevel(session.proc, mode)

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode
      }
    })

    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)

    return {}
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = await this.restoreSession(params.sessionId)
    if (session.hasActiveTurn) throw RequestError.invalidRequest('Pi configuration requires an idle session')
    const configId = String(params.configId)

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(`Expected string value for config option: ${configId}`)
    }

    if (configId === MODEL_CONFIG_ID) {
      if (this.store.get(params.sessionId)?.managedPreFile) this.store.consumeManagedPreFile(params.sessionId)
      await setSessionModel(session.proc, params.value)
      await this.confirmInitialModelSelection(session, params.value)
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${params.value}`)
      }

      await setNativeThinkingLevel(session.proc, params.value)

      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: params.value
        }
      })
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`)
    }

    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc)
    const nativeFirstUse = this.nativeFirstUse.get(session.sessionId)
    return {
      configOptions,
      ...(nativeFirstUse ? { _meta: { farfoldPi: { version: PI_EXTENSION_VERSION, nativeFirstUse } } } : {})
    }
  }

  private async confirmInitialModelSelection(session: PiAcpSession, requested: string): Promise<void> {
    if (!this.nativeFirstUse.has(session.sessionId)) return
    const [state, available] = await Promise.all([session.proc.getState(), session.proc.getAvailableModels()])
    const actual = state as {
      model?: { provider?: string; id?: string }
      isStreaming?: boolean
      isCompacting?: boolean
      pendingMessageCount?: number
    }
    const models = (available as { models?: Array<{ provider?: string; id?: string }> }).models
    if (
      actual.isStreaming !== false ||
      actual.isCompacting !== false ||
      actual.pendingMessageCount !== 0 ||
      !actual.model?.provider ||
      !actual.model?.id ||
      !Array.isArray(models) ||
      (requested !== actual.model.id && requested !== `${actual.model.provider}/${actual.model.id}`) ||
      !models.some(model => model.provider === actual.model?.provider && model.id === actual.model?.id)
    )
      throw RequestError.invalidRequest('Pi initial model selection was not confirmed')
    await this.describeSession(session)
    const ready: PiNativeFirstUseState = {
      version: 1,
      phase: 'ready',
      provider: actual.model.provider,
      modelId: actual.model.id
    }
    await session.proc.recordNativeFirstUse(ready)
    this.nativeFirstUse.set(session.sessionId, ready)
    this.store.setNativeFirstUse(session.sessionId, ready)
  }
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh' || x === 'max'
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  const state = pre?.state ?? ((await proc.getState()) as { thinkingLevel?: unknown })
  const data = (await proc.getAvailableThinkingLevels()) as { levels?: unknown }
  if (
    !Array.isArray(data?.levels) ||
    !data.levels.length ||
    !data.levels.every(level => typeof level === 'string' && isThinkingLevel(level))
  )
    throw RequestError.internalError({}, 'Pi did not return valid thinking levels')
  const available = [...new Set(data.levels)] as ThinkingLevel[]
  const current = state?.thinkingLevel
  if (typeof current !== 'string' || !available.includes(current as ThinkingLevel))
    throw RequestError.internalError({}, 'Pi current thinking level is not in its native options')

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

async function setNativeThinkingLevel(proc: PiRpcProcess, level: ThinkingLevel): Promise<void> {
  const before = await getThinkingState(proc)
  if (!before.availableModes.some(mode => mode.id === level))
    throw RequestError.invalidParams('Thinking level is not supported by this Pi model')
  await proc.setThinkingLevel(level)
  const after = await getThinkingState(proc)
  if (after.currentModeId !== level)
    throw RequestError.internalError({}, 'Pi did not apply the requested thinking level')
}

async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  configOptions: SessionConfigOption[]
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}> {
  const [models, modes] = await Promise.all([getModelState(proc, pre), getThinkingState(proc, { state: pre?.state })])

  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes
  }
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ]

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: 'select',
      id: MODEL_CONFIG_ID,
      category: 'model',
      name: 'Model',
      description: 'Select the model for this session',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return configOptions
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch {
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(Boolean) as AdvertisedModel[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch {
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? 'default'
  }
}

async function emitConfigOptionsUpdate(
  conn: AgentSideConnection,
  sessionId: string,
  proc: PiRpcProcess
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc)

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions
    }
  })

  return configOptions
}

async function setSessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [candidateProvider, ...rest] = requestedModelId.split('/')
    provider = candidateProvider
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(m => String(m?.id) === modelId)
    if (found) {
      provider = String(found.provider)
      modelId = String(found.id)
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(provider, modelId)
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: {
  cwd: string
  fileCommands: ReturnType<typeof loadSlashCommands>
  updateNotice: string | null
}): string {
  void opts.fileCommands

  const md: string[] = []

  // pi version header
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Prompts
  const promptsItems: string[] = []
  const promptsDir = join(process.env.HOME ?? '', '.pi', 'agent', 'prompts')
  try {
    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md'))
    for (const f of prompts) promptsItems.push(`/${basename(f, '.md')}`)
  } catch {
    // ignore
  }
  addSection('Prompts', promptsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(process.env.HOME ?? '', '.pi', 'agent', 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (global + project)
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(opts.cwd, '.pi', 'settings.json')]
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
      const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
      for (const pkg of pkgs) {
        const s = String(pkg)
        if (s.startsWith('npm:')) {
          extItems.push(`${s}\n  - index.ts`)
        } else {
          extItems.push(s)
        }
      }
    } catch {
      // ignore
    }
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

// Public package code only. Never import the package: its entrypoint starts an Agent.
const out = __dirname;
const provenance = JSON.parse(fs.readFileSync(path.join(out, 'official-source-manifest.json'), 'utf8'));
const source = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : null;
if (source) assert.equal(crypto.createHash('sha256').update(source).digest('hex'), provenance.adapter.sha256, 'This replay reproduces the recorded source; hash is not a production eligibility rule');
const spans = source ? [] : provenance.adapter.spans;
function exact(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, end);
  const value = source.slice(from, to);
  spans.push({ start, firstLine: source.slice(0, from).split('\n').length, lastLine: source.slice(0, to).split('\n').length - 1, sha256: crypto.createHash('sha256').update(value).digest('hex') });
  return value;
}

const methods = source ? [
  exact('  async newSession(request) {', '  async closeSession(sessionId) {'),
  exact('  async loadSession(request, onSubscribed) {', '  async readSessionThread(sessionId) {'),
  exact('  async resumeSession(request, onSubscribed) {', '  async forkSession(request) {'),
  exact('  async createSessionConfig(projectPath, additionalDirectories, mcpServers) {', '  getModelProvider() {'),
  exact('  createMcpSeverConfig(mcpServer) {', '  /**\n   * Resolves a ModelId')
].join('\n') : '';
const helpers = source ? [
  exact('function sanitizeMcpServerName(name) {', '\n// package.json'),
  exact('function shouldDeduplicateMcpConflicts() {', 'function readMetaAdditionalRoots(meta3) {'),
  exact('function readMetaAdditionalRoots(meta3) {', 'function mergeSandboxWorkspaceWriteRoots(config2, roots) {'),
  exact('function mergeSandboxWorkspaceWriteRoots(config2, roots) {', 'function addAdditionalDirectoriesToSandboxPolicy(sandboxPolicy, additionalDirectories) {'),
  exact('function uniqueStrings(values) {', 'function gatewayApiTypeFromConfig(gatewayConfig) {'),
  exact('function mergeGatewayConfig(config2, gatewayConfig) {', '\n// src/CodexAppServerClient.ts')
].join('\n') : '';
const loggerSource = source ? exact('var Logger = class {', 'var logger = new Logger();') : '';
const attachSource = source ? exact('function attachLogs(proc) {', '\n// src/AcpSessionExtensions.ts') : '';
const extracted = source ? `${helpers}\nclass Subject {\n${methods}\n}\n${loggerSource}\n${attachSource}\nthis.Subject = Subject; this.Logger = Logger; this.attachLogs = attachLogs;` : fs.readFileSync(path.join(out, 'official-adapter-extract.js'), 'utf8');
assert.equal(crypto.createHash('sha256').update(extracted).digest('hex'), provenance.adapter.extractSha256);
// The checked-in extract is never rewritten by this replay.

const fakeEnv = {}; // All env values below are synthetic, never host process.env.
let logs = [];
const sandbox = {
  process: { env: fakeEnv, pid: 123 },
  console: { error: (...args) => { throw Error('Unexpected official logger error: ' + String(args[0])); } },
  path, path7: path,
  fs: { mkdirSync() {}, appendFileSync: (name, text) => logs.push({ name, text }) },
  logger: { log() {} },
  MCP_SERVER_NAME_WHITESPACE: /\p{White_Space}/gu,
  gatewayApiTypeFromConfig: () => { throw Error('Gateway branch is out of scope'); },
  RequestError: { invalidRequest: (message) => Error(message), invalidParams: (_, message) => Error(message) },
};
vm.createContext(sandbox);
vm.runInContext(extracted, sandbox, { filename: 'official-adapter-extract.js' });
const clone = (value) => JSON.parse(JSON.stringify(value));
const native = {
  model: 'synthetic-model',
  model_provider: 'synthetic-provider',
  mcp_servers: {
    existing_global: { url: 'https://native.example.invalid/mcp', enabled: true },
    existing_project: { command: '/synthetic/native-tool', args: ['--stdio'], env: { SYNTHETIC_NATIVE_FLAG: 'retained' } },
  },
};
const temporary = { name: 'farfold_browser_fixture', command: '/synthetic/farfold', args: ['--browser-tool'], env: [{ name: 'FARFOLD_BROWSER_TOKEN', value: 'SYNTHETIC_TEMPORARY_TOKEN_NOT_REAL' }] };
const cases = [];
function client(config = {}) {
  const calls = [];
  const c = new sandbox.Subject();
  c.config = clone(config);
  c.gatewayConfig = null;
  c.getNativeProviderConfig = () => ({ apiType: 'openai', baseUrl: 'https://provider.example.invalid' });
  c.getModelProvider = () => 'synthetic-provider';
  c.getResumeModelProvider = async () => 'synthetic-provider';
  c.refreshSkills = async () => {};
  c.fetchAvailableModels = async () => [{ id: 'synthetic-model' }];
  c.createModelId = () => ({ toString: () => 'synthetic-model' });
  c.getCollaborationMode = () => 'default';
  const response = { thread: { id: 'synthetic-thread', historyMode: 'paginated' }, turnsBackwardsCursor: null, model: 'synthetic-model', modelProvider: 'synthetic-provider' };
  c.codexClient = {
    configRead: async (params) => { calls.push({ method: 'config/read', params: clone(params) }); return { config: clone(native), layers: [{ config: { mcp_servers: { disabled_layer_server: { enabled: false } } } }] }; },
    threadStart: async (params) => { calls.push({ method: 'thread/start', params: clone(params) }); return clone(response); },
    threadResume: async (params) => { calls.push({ method: 'thread/resume', params: clone(params) }); return clone(response); },
  };
  return { c, calls };
}

(async () => {
  for (const method of ['newSession', 'loadSession', 'resumeSession']) {
    const inline = { model: 'synthetic-model', model_providers: { fixture: { name: 'Synthetic provider', base_url: 'https://provider.example.invalid' } } };
    const { c, calls } = client(inline);
    await c[method]({ cwd: '/synthetic/project', sessionId: 'synthetic-thread', mcpServers: [temporary] });
    assert.equal(calls[0].method, 'config/read');
    assert.deepEqual(calls[0].params, { includeLayers: true, cwd: '/synthetic/project' });
    const sent = calls.at(-1);
    assert.equal(sent.method, method === 'newSession' ? 'thread/start' : 'thread/resume');
    assert.deepEqual(sent.params.config.model_providers, inline.model_providers);
    assert.equal(sent.params.config.mcp_servers.farfold_browser_fixture.env.FARFOLD_BROWSER_TOKEN, temporary.env[0].value);
    assert.deepEqual(Object.keys(sent.params.config.mcp_servers), ['farfold_browser_fixture']);
    cases.push({ name: method, result: 'pass', native, adapterOverride: sent.params.config, appServerMethod: sent.method });
  }
  {
    const { c } = client({ mcp_servers: { inline_only: { command: '/synthetic/inline-tool', args: [] } } });
    const result = clone(await c.createSessionConfig('/synthetic/project', [], [temporary]));
    assert.equal(result.mcp_servers.inline_only, undefined);
    assert.ok(result.mcp_servers.farfold_browser_fixture);
    cases.push({ name: 'inline-CODEX_CONFIG-mcp-is-overwritten', result: 'confirmed-risk', missingName: 'inline_only' });
  }
  {
    const { c, calls } = client();
    const result = clone(await c.createSessionConfig('/synthetic/project', [], [{ ...temporary, name: 'existing_global' }, { ...temporary, name: 'disabled_layer_server' }]));
    assert.equal(result.mcp_servers, undefined);
    assert.equal(calls.length, 1);
    cases.push({ name: 'configured-and-disabled-layer-name-collision-filtered', result: 'pass' });
  }
  {
    fakeEnv.DISABLE_MCP_CONFIG_FILTERING = 'true';
    const { c, calls } = client();
    const result = clone(await c.createSessionConfig('/synthetic/project', [], [{ ...temporary, name: 'existing_global' }]));
    assert.equal(calls.length, 0);
    assert.ok(result.mcp_servers.existing_global);
    delete fakeEnv.DISABLE_MCP_CONFIG_FILTERING;
    cases.push({ name: 'explicit-filtering-disable-honored-by-official-adapter', result: 'confirmed-risk-on-name-collision' });
  }
  for (const flag of [undefined, '', '0', 'false', ' ', '/synthetic/logs']) {
    logs = [];
    if (flag === undefined) delete fakeEnv.APP_SERVER_LOGS; else fakeEnv.APP_SERVER_LOGS = flag;
    const logger = new sandbox.Logger();
    const logged = logs;
    sandbox.logger = logger;
    let written = null;
    const proc = { stdin: { write(chunk) { written = chunk; return true; } }, stdout: { on() {} }, stderr: { on() {} }, on() {} };
    sandbox.attachLogs(proc);
    const frame = JSON.stringify({ method: 'thread/start', params: { config: { mcp_servers: { fixture: { env: { FARFOLD_BROWSER_TOKEN: temporary.env[0].value } } } } } });
    proc.stdin.write(frame);
    assert.equal(written, frame);
    const containsTemporaryToken = logged.some(({ text }) => text.includes(temporary.env[0].value));
    assert.equal(containsTemporaryToken, Boolean(flag));
    cases.push({ name: `logger-${flag === undefined ? 'missing' : JSON.stringify(flag)}`, result: 'pass', syntheticTemporaryTokenLogged: containsTemporaryToken });
  }
  const receipt = {
    kind: 'exact-public-function-execution-with-synthetic-transport-and-env',
    source: { package: '@agentclientprotocol/codex-acp', version: '1.13.1', sha256: provenance.adapter.sha256, spans },
    actualAgentsStarted: 0, modelMessages: 0, userConfigReads: 0, userEnvironmentReads: 0,
    boundaries: ['No package import or entrypoint execution', 'No app-server process or model calls', 'config/read response, thread RPC, unrelated skill/model methods, and fs log sink are synthetic', 'Core adapter methods and Logger/attachLogs are unmodified exact source slices', 'Rust downstream merge is verified separately'],
    cases,
  };
  fs.writeFileSync(path.join(out, 'adapter-results.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ scenariosChecked: cases.length, sourceSha256: receipt.source.sha256, confirmedInlineOverrideRisk: true, actualAgentsStarted: 0, modelMessages: 0 }));
})().catch((error) => { console.error(error); process.exitCode = 1; });

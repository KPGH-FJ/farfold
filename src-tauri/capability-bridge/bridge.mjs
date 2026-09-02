import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

const EXPECTED_PI_VERSION = "0.84.3";
const packageUrl = new URL(
  "../package.json",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const sdkPackage = JSON.parse(await readFile(packageUrl, "utf8"));

if (sdkPackage.version !== EXPECTED_PI_VERSION) {
  throw new Error(
    `Pi capability SDK mismatch: expected ${EXPECTED_PI_VERSION}, found ${sdkPackage.version}`,
  );
}

const agentDir =
  process.env.FARFOLD_PI_AGENT_DIR || join(homedir(), ".pi", "agent");
const authPath = join(agentDir, "auth.json");
const modelsPath = join(agentDir, "models.json");
const modelsStorePath = join(agentDir, "models-store.json");
const runtimeOptions = {
  authPath,
  modelsPath,
  modelsStorePath,
  allowModelNetwork: false,
};
let modelRuntime = await ModelRuntime.create(runtimeOptions);

let activeLogin = null;
let promptSequence = 0;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorMessage(reason) {
  return reason instanceof Error ? reason.message : String(reason);
}

function safeModel(model, available) {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    thinkingLevelMap: model.thinkingLevelMap,
    thinkingLevels: getSupportedThinkingLevels(model),
    available,
  };
}

function settingsSnapshot(projectPath) {
  const cwd = projectPath || process.cwd();
  const settings = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  return {
    defaultProvider: settings.getDefaultProvider() || null,
    defaultModel: settings.getDefaultModel() || null,
    defaultThinkingLevel: settings.getDefaultThinkingLevel() || null,
    enabledModels: settings.getEnabledModels() || null,
  };
}

async function readModelsDocument() {
  try {
    const parsed = JSON.parse(await readFile(modelsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Pi models.json must contain a JSON object");
    }
    return parsed;
  } catch (reason) {
    if (reason?.code === "ENOENT") return {};
    throw reason;
  }
}

async function customProviderIds() {
  const document = await readModelsDocument();
  const providers = document.providers;
  return providers && typeof providers === "object" && !Array.isArray(providers)
    ? Object.keys(providers)
    : [];
}

async function snapshot(projectPath) {
  const credentialInfo = await modelRuntime.listCredentials({
    signal: AbortSignal.timeout(10_000),
  });
  const credentialTypes = new Map(
    credentialInfo.map((credential) => [
      credential.providerId,
      credential.type,
    ]),
  );
  const availableModels = await modelRuntime.getAvailable(undefined, {
    signal: AbortSignal.timeout(15_000),
  });
  const availableKeys = new Set(
    availableModels.map((model) => `${model.provider}\u0000${model.id}`),
  );
  const providers = modelRuntime.getProviders().map((provider) => {
    const status = modelRuntime.getProviderAuthStatus(provider.id);
    const methods = [];
    if (provider.auth.apiKey) {
      methods.push({
        type: "api_key",
        name: provider.auth.apiKey.name,
        interactive: typeof provider.auth.apiKey.login === "function",
      });
    }
    if (provider.auth.oauth) {
      methods.push({
        type: "oauth",
        name: provider.auth.oauth.name,
        label: provider.auth.oauth.loginLabel || provider.auth.oauth.name,
        subscription: provider.auth.oauth.isSubscription === true,
        interactive: true,
      });
    }
    return {
      id: provider.id,
      name: provider.name,
      configured: status.configured,
      source: status.source || null,
      sourceLabel: status.label || null,
      credentialType: credentialTypes.get(provider.id) || null,
      methods,
      modelCount: modelRuntime.getModels(provider.id).length,
    };
  });
  const knownIds = new Set(providers.map((provider) => provider.id));
  const orphanCredentials = credentialInfo
    .filter((credential) => !knownIds.has(credential.providerId))
    .map((credential) => ({
      providerId: credential.providerId,
      type: credential.type,
    }));
  return {
    sdkVersion: sdkPackage.version,
    refreshedAt: Date.now(),
    providers,
    models: modelRuntime
      .getModels()
      .map((model) =>
        safeModel(
          model,
          availableKeys.has(`${model.provider}\u0000${model.id}`),
        ),
      ),
    customProviderIds: await customProviderIds(),
    orphanCredentials,
    settings: settingsSnapshot(projectPath),
  };
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new Error(
      `${label} must use letters, numbers, dot, underscore, or dash`,
    );
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

async function upsertCustomProvider(command) {
  const providerId = requireIdentifier(command.providerId, "Provider id");
  const modelId = requireIdentifier(command.modelId, "Model id");
  const allowedApis = new Set([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ]);
  if (!allowedApis.has(command.api)) {
    throw new Error("Unsupported Pi API adapter");
  }
  let baseUrl;
  try {
    baseUrl = new URL(command.baseUrl);
  } catch {
    throw new Error("Base URL is invalid");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }

  const document = await readModelsDocument();
  const providers =
    document.providers &&
    typeof document.providers === "object" &&
    !Array.isArray(document.providers)
      ? document.providers
      : {};
  const existing =
    providers[providerId] &&
    typeof providers[providerId] === "object" &&
    !Array.isArray(providers[providerId])
      ? providers[providerId]
      : null;
  if (!existing && modelRuntime.getProvider(providerId)) {
    throw new Error("Built-in Pi Providers cannot be replaced by this form");
  }
  const existingModels = Array.isArray(existing?.models) ? existing.models : [];
  const model = {
    id: modelId,
    name:
      typeof command.modelName === "string" && command.modelName.trim()
        ? command.modelName.trim()
        : modelId,
    reasoning: command.reasoning === true,
    input: command.imageInput === true ? ["text", "image"] : ["text"],
    contextWindow: requirePositiveInteger(
      command.contextWindow,
      "Context window",
    ),
    maxTokens: requirePositiveInteger(command.maxTokens, "Max tokens"),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const modelIndex = existingModels.findIndex((entry) => entry?.id === modelId);
  const models = [...existingModels];
  if (modelIndex >= 0) models[modelIndex] = { ...models[modelIndex], ...model };
  else models.push(model);
  const compat = {
    ...(existing?.compat &&
    typeof existing.compat === "object" &&
    !Array.isArray(existing.compat)
      ? existing.compat
      : {}),
    supportsDeveloperRole: command.supportsDeveloperRole === true,
    supportsReasoningEffort: command.supportsReasoningEffort === true,
  };
  providers[providerId] = {
    ...(existing || {}),
    name:
      typeof command.providerName === "string" && command.providerName.trim()
        ? command.providerName.trim()
        : providerId,
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    api: command.api,
    ...(command.localKeyless === true ? { apiKey: "farfold-local" } : {}),
    compat,
    models,
  };
  if (command.localKeyless !== true && existing?.apiKey === "farfold-local") {
    delete providers[providerId].apiKey;
  }
  const nextDocument = { ...document, providers };
  const temporaryPath = `${modelsPath}.tmp.${process.pid}-${randomUUID()}`;
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(nextDocument, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    const candidateRuntime = await ModelRuntime.create({
      ...runtimeOptions,
      modelsPath: temporaryPath,
      refreshOnCreate: false,
    });
    const configError = candidateRuntime.getError();
    if (configError) throw new Error(configError);
    await rename(temporaryPath, modelsPath);
    await chmod(modelsPath, 0o600);
  } catch (reason) {
    await unlink(temporaryPath).catch(() => undefined);
    throw reason;
  }
  modelRuntime = await ModelRuntime.create(runtimeOptions);
  return snapshot(command.projectPath);
}

function finishPrompt(login, promptId, resolution) {
  const pending = login.pendingPrompts.get(promptId);
  if (!pending) return false;
  login.pendingPrompts.delete(promptId);
  pending.cleanup();
  resolution(pending);
  return true;
}

function startLogin(command) {
  if (activeLogin) {
    throw new Error("Another Provider login is already in progress");
  }
  const controller = new AbortController();
  const login = {
    requestId: command.id,
    providerId: command.providerId,
    controller,
    pendingPrompts: new Map(),
  };
  activeLogin = login;

  void modelRuntime
    .login(command.providerId, command.authType, {
      signal: controller.signal,
      notify(event) {
        write({
          type: "auth_event",
          requestId: command.id,
          providerId: command.providerId,
          event,
        });
      },
      prompt(prompt) {
        promptSequence += 1;
        const promptId = `auth-prompt-${promptSequence}`;
        return new Promise((resolve, reject) => {
          const abort = () => {
            finishPrompt(login, promptId, ({ reject: rejectPrompt }) =>
              rejectPrompt(new Error("Provider login prompt was cancelled")),
            );
          };
          const signals = [controller.signal, prompt.signal].filter(Boolean);
          for (const signal of signals) {
            signal.addEventListener("abort", abort, { once: true });
          }
          login.pendingPrompts.set(promptId, {
            resolve,
            reject,
            cleanup() {
              for (const signal of signals) {
                signal.removeEventListener("abort", abort);
              }
            },
          });
          const { signal: _signal, ...serializablePrompt } = prompt;
          write({
            type: "auth_prompt",
            requestId: command.id,
            promptId,
            providerId: command.providerId,
            prompt: serializablePrompt,
          });
        });
      },
    })
    .then(
      async (credential) => {
        await modelRuntime.refresh({
          providers: [command.providerId],
          signal: AbortSignal.timeout(20_000),
        });
        write({
          type: "response",
          id: command.id,
          command: "login",
          success: true,
          data: {
            providerId: command.providerId,
            credentialType: credential.type,
          },
        });
      },
      (reason) => {
        write({
          type: "response",
          id: command.id,
          command: "login",
          success: false,
          error: errorMessage(reason),
        });
      },
    )
    .finally(() => {
      if (activeLogin === login) activeLogin = null;
    });
}

async function handle(command) {
  if (
    !command ||
    typeof command !== "object" ||
    typeof command.id !== "string"
  ) {
    throw new Error("Capability command requires an id");
  }
  switch (command.type) {
    case "snapshot":
      return snapshot(command.projectPath);
    case "refresh": {
      const result = await modelRuntime.refresh({
        signal: AbortSignal.timeout(30_000),
      });
      return { result, snapshot: await snapshot(command.projectPath) };
    }
    case "login":
      startLogin(command);
      return undefined;
    case "auth_response": {
      if (!activeLogin || activeLogin.requestId !== command.requestId) {
        throw new Error("Provider login is no longer active");
      }
      const accepted = finishPrompt(
        activeLogin,
        command.promptId,
        ({ resolve }) => resolve(command.value),
      );
      if (!accepted)
        throw new Error("Provider login prompt is no longer active");
      return { accepted: true };
    }
    case "auth_cancel":
      if (activeLogin && activeLogin.requestId === command.requestId) {
        activeLogin.controller.abort();
      }
      return { cancelled: true };
    case "test_connection": {
      const candidates = (
        await modelRuntime.getAvailable(command.providerId, {
          signal: AbortSignal.timeout(15_000),
        })
      )
        .filter((model) => model.input.includes("text"))
        .sort((left, right) => {
          // This ordering only minimizes the cost of an explicit connection
          // probe. It is not a Farfold model recommendation or runtime policy.
          const leftCost = left.cost.input + left.cost.output;
          const rightCost = right.cost.input + right.cost.output;
          return leftCost - rightCost || left.id.localeCompare(right.id);
        });
      const model = candidates[0];
      if (!model) {
        throw new Error(
          `No available text model for Provider ${command.providerId}`,
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await modelRuntime.completeSimple(
          model,
          {
            systemPrompt: "This is a connection probe. Reply with OK.",
            messages: [
              {
                role: "user",
                content: "Reply OK.",
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens: 4,
            reasoning: "off",
            maxRetries: 0,
            signal: controller.signal,
          },
        );
        if (response.stopReason === "error" || response.errorMessage) {
          throw new Error(response.errorMessage || "Provider request failed");
        }
        return {
          providerId: command.providerId,
          model: {
            provider: model.provider,
            id: model.id,
            name: model.name,
          },
          checkedAt: Date.now(),
        };
      } finally {
        clearTimeout(timeout);
      }
    }
    case "upsert_custom_provider":
      return upsertCustomProvider(command);
    case "logout":
      await modelRuntime.logout(command.providerId, {
        signal: AbortSignal.timeout(15_000),
      });
      return { providerId: command.providerId };
    case "set_defaults": {
      const settings = SettingsManager.create(
        command.projectPath || process.cwd(),
        agentDir,
        { projectTrusted: false },
      );
      settings.setDefaultModelAndProvider(command.providerId, command.modelId);
      if (command.thinkingLevel) {
        settings.setDefaultThinkingLevel(command.thinkingLevel);
      }
      await settings.flush();
      const errors = settings.drainErrors();
      if (errors.length) {
        throw new Error(errors.map((entry) => entry.error.message).join("; "));
      }
      return settingsSnapshot(command.projectPath);
    }
    default:
      throw new Error(`Unknown capability command: ${command.type}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void (async () => {
    let command;
    try {
      command = JSON.parse(line);
      const data = await handle(command);
      if (data !== undefined) {
        write({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data,
        });
      }
    } catch (reason) {
      write({
        type: "response",
        id: command?.id,
        command: command?.type,
        success: false,
        error: errorMessage(reason),
      });
    }
  })();
});

input.on("close", () => {
  activeLogin?.controller.abort();
});

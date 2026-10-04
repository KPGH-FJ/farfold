function sanitizeMcpServerName(name) {
  return name.replace(MCP_SERVER_NAME_WHITESPACE, "_");
}

function shouldDeduplicateMcpConflicts() {
  const disabledByEnv = process.env["DISABLE_MCP_CONFIG_FILTERING"] === "true";
  return !disabledByEnv;
}

function readMetaAdditionalRoots(meta3) {
  const rawRoots = meta3?.["additionalRoots"];
  if (!Array.isArray(rawRoots)) {
    return void 0;
  }
  return uniqueStrings(rawRoots.filter((value) => typeof value === "string").map((value) => value.trim()).filter((value) => value.length > 0));
}
function readAdditionalDirectories(cwd, additionalDirectories, meta3) {
  const rawDirectories = additionalDirectories ?? readMetaAdditionalRoots(meta3);
  if (!rawDirectories) {
    return [];
  }
  const directories = [];
  const seen = /* @__PURE__ */ new Set([cwd]);
  for (const directory of rawDirectories) {
    if (typeof directory !== "string") {
      throw RequestError.invalidParams(void 0, "additionalDirectories entries must be strings");
    }
    if (directory.length === 0) {
      throw RequestError.invalidParams(void 0, "additionalDirectories entries must not be empty");
    }
    if (!path7.isAbsolute(directory)) {
      throw RequestError.invalidParams(void 0, "additionalDirectories entries must be absolute paths");
    }
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

function mergeSandboxWorkspaceWriteRoots(config2, roots) {
  if (roots.length === 0) {
    return config2;
  }
  const existingSandboxConfig = isJsonObject(config2["sandbox_workspace_write"]) ? config2["sandbox_workspace_write"] : {};
  const existingWritableRoots = Array.isArray(existingSandboxConfig["writable_roots"]) ? existingSandboxConfig["writable_roots"].filter((value) => typeof value === "string") : [];
  return {
    ...config2,
    sandbox_workspace_write: {
      ...existingSandboxConfig,
      writable_roots: uniqueStrings([...existingWritableRoots, ...roots])
    }
  };
}
function forceGitRootTurnDiffPaths(config2) {
  const features = isJsonObject(config2["features"]) ? config2["features"] : {};
  return {
    ...config2,
    features: {
      ...features,
      cwd_relative_turn_diffs: false
    }
  };
}

function uniqueStrings(values) {
  return Array.from(new Set(values));
}
function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeGatewayConfig(config2, gatewayConfig) {
  if (gatewayConfig !== null) {
    const newConfig = { ...config2 };
    if (!newConfig["model_providers"] || typeof newConfig["model_providers"] !== "object") {
      newConfig["model_providers"] = {};
    } else {
      newConfig["model_providers"] = { ...newConfig["model_providers"] };
    }
    newConfig["model_providers"][gatewayConfig.modelProvider] = gatewayConfig.config;
    return newConfig;
  } else {
    return config2;
  }
}

class Subject {
  async newSession(request) {
    const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
    await this.refreshSkills(request.cwd, additionalDirectories);
    const response = await this.codexClient.threadStart({
      config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers),
      modelProvider: this.getModelProvider(),
      cwd: request.cwd
    });
    const codexModels = await this.fetchAvailableModels();
    if (codexModels.length === 0) {
      throw new Error("Codex did not return any models");
    }
    const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
    return {
      sessionId: response.thread.id,
      currentModelId,
      models: codexModels,
      collaborationMode: this.getCollaborationMode(response.thread.id),
      modelProvider: response.modelProvider,
      currentServiceTier: response.serviceTier ?? null,
      additionalDirectories
    };
  }

  async loadSession(request, onSubscribed) {
    const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
    await this.refreshSkills(request.cwd, additionalDirectories);
    const response = await this.codexClient.threadResume({
      excludeTurns: true,
      config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers ?? []),
      cwd: request.cwd,
      modelProvider: await this.getResumeModelProvider(),
      threadId: request.sessionId
    });
    onSubscribed?.();
    const thread = response.thread.historyMode === "paginated" ? {
      ...response.thread,
      turns: response.turnsBackwardsCursor === null ? [] : await this.codexClient.threadReadHistory(response.thread.id, response.turnsBackwardsCursor)
    } : (await this.codexClient.threadReadWithHistory(response.thread.id)).thread;
    const codexModels = await this.fetchAvailableModels();
    const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
    return {
      sessionId: request.sessionId,
      currentModelId,
      models: codexModels,
      collaborationMode: this.getCollaborationMode(response.thread.id),
      modelProvider: response.modelProvider,
      currentServiceTier: response.serviceTier ?? null,
      thread,
      additionalDirectories
    };
  }

  async resumeSession(request, onSubscribed) {
    const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);
    await this.refreshSkills(request.cwd, additionalDirectories);
    const response = await this.codexClient.threadResume({
      excludeTurns: true,
      config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers ?? []),
      cwd: request.cwd,
      modelProvider: await this.getResumeModelProvider(),
      threadId: request.sessionId
    });
    onSubscribed?.();
    const codexModels = await this.fetchAvailableModels();
    const currentModelId = this.createModelId(codexModels, response.model, response.reasoningEffort).toString();
    return {
      sessionId: request.sessionId,
      currentModelId,
      models: codexModels,
      collaborationMode: this.getCollaborationMode(response.thread.id),
      modelProvider: response.modelProvider,
      currentServiceTier: response.serviceTier ?? null,
      additionalDirectories
    };
  }

  async createSessionConfig(projectPath, additionalDirectories, mcpServers) {
    const sessionRoots = [projectPath, ...additionalDirectories];
    const activeProvider = this.gatewayConfig ? {
      apiType: gatewayApiTypeFromConfig(this.gatewayConfig),
      baseUrl: this.gatewayConfig.config.base_url
    } : this.getNativeProviderConfig();
    logger.log("Creating session config", {
      projectPath,
      overrideActive: this.gatewayConfig !== null,
      modelProvider: this.getModelProvider(),
      apiType: activeProvider.apiType,
      baseUrl: activeProvider.baseUrl
    });
    const mergedConfig = {
      ...forceGitRootTurnDiffPaths(mergeGatewayConfig(this.config, this.gatewayConfig)),
      projects: Object.fromEntries(sessionRoots.map((root) => [root, {
        trust_level: "trusted"
      }]))
    };
    const configWithWorkspaceRoots = mergeSandboxWorkspaceWriteRoots(mergedConfig, additionalDirectories);
    if (mcpServers.length === 0) {
      return configWithWorkspaceRoots;
    }
    const requestedServers = mcpServers.map((mcp) => ({
      name: sanitizeMcpServerName(mcp.name),
      server: mcp
    }));
    let serversToConfigure = requestedServers;
    if (shouldDeduplicateMcpConflicts()) {
      const existingNames = await this.getConfigMcpServerNames(projectPath);
      serversToConfigure = requestedServers.filter((mcp) => !existingNames.has(mcp.name));
    }
    if (serversToConfigure.length === 0) {
      return configWithWorkspaceRoots;
    }
    return {
      ...configWithWorkspaceRoots,
      "mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))
    };
  }
  async getConfigMcpServerNames(projectPath) {
    const response = await this.codexClient.configRead({ includeLayers: true, cwd: projectPath });
    const effectiveMcpServers = response?.config?.["mcp_servers"];
    const configLayers = response?.layers ?? [];
    const layerMcpServers = configLayers.map((layer) => {
      return isJsonObject(layer.config) ? layer.config["mcp_servers"] : void 0;
    });
    const configuredMcpServers = [effectiveMcpServers, ...layerMcpServers].filter(isJsonObject);
    if (configuredMcpServers.length === 0) {
      return /* @__PURE__ */ new Set();
    }
    return new Set(configuredMcpServers.flatMap((server) => Object.keys(server)));
  }

  createMcpSeverConfig(mcpServer) {
    if ("type" in mcpServer) {
      switch (mcpServer.type) {
        case "acp":
          throw RequestError.invalidRequest("Codex doesn't support MCP ACP transport protocol");
        case "sse":
          throw RequestError.invalidRequest("Codex doesn't support MCP SSE transport protocol");
        case "http":
          return {
            "url": mcpServer.url,
            "http_headers": Object.fromEntries(mcpServer.headers.map((h) => [h.name, h.value]))
          };
      }
    }
    return {
      "command": mcpServer.command,
      "args": mcpServer.args,
      "env": Object.fromEntries(mcpServer.env.map((env) => [env.name, env.value]))
    };
  }

}
var Logger = class {
  logFilePath;
  constructor() {
    const logDir = process.env["APP_SERVER_LOGS"];
    if (!logDir) {
      this.logFilePath = null;
      return;
    }
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.logFilePath = path.join(logDir, "app-server.log");
      this.log("Logger initialized", { logFilePath: this.logFilePath });
    } catch (ex) {
      console.error("Failed to initialize logger directory", ex);
      this.logFilePath = null;
    }
  }
  error(message, err) {
    const formattedError = this.formatError(err);
    if (!this.logFilePath) {
      console.error(`[SYSTEM_ERROR] ${message}: ${formattedError}`);
      return;
    }
    this.log(`[SYSTEM_ERROR] ${message}`, { exception: formattedError });
  }
  log(message, context) {
    if (!this.logFilePath) return;
    try {
      const timestamp = this.formatTimestamp(/* @__PURE__ */ new Date());
      const serializedContext = ` ${JSON.stringify({ pid: process.pid, ...context })}`;
      if (!message.startsWith("[")) message = `[SYS] ${message}`;
      const line = `${timestamp} ${message}${serializedContext}`;
      fs.appendFileSync(this.logFilePath, `${line}
`);
    } catch (ex) {
      console.error("Logger write failed", ex);
    }
  }
  formatTimestamp(date5) {
    const yyyy = date5.getFullYear();
    const mm = String(date5.getMonth() + 1).padStart(2, "0");
    const dd = String(date5.getDate()).padStart(2, "0");
    const hh = String(date5.getHours()).padStart(2, "0");
    const min = String(date5.getMinutes()).padStart(2, "0");
    const ss = String(date5.getSeconds()).padStart(2, "0");
    const ms = String(date5.getMilliseconds()).padStart(3, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss},${ms}`;
  }
  formatError(err) {
    if (err instanceof Error) {
      const parts = [`${err.name}: ${err.message}`];
      if (err.stack) {
        parts.push(err.stack);
      }
      if ("cause" in err && err.cause) {
        parts.push(`Caused by: ${this.formatError(err.cause)}`);
      }
      return parts.join("\n");
    }
    if (typeof err === "string") {
      return err;
    }
    return String(err);
  }
};

function attachLogs(proc) {
  const originalWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = (chunk, encoding, callback) => {
    logger.log(`[IN] ${chunk.toString()}`);
    return originalWrite(chunk, encoding, callback);
  };
  proc.stderr.on("data", (data) => {
    logger.log(`[ERR] ${data.toString()}`);
  });
  proc.stdout.on("data", (data) => {
    logger.log(`[OUT] ${data.toString()}`);
  });
  proc.on("exit", (code) => {
    logger.log(`[EXIT] code: ${code?.toString()}`);
  });
}

this.Subject = Subject; this.Logger = Logger; this.attachLogs = attachLogs;
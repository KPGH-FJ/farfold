export type RuntimeCapabilityLevel = "supported" | "unsupported";

export interface RuntimeIdentity {
  productId: string;
  installationId: string;
  adapterId: string;
}

export interface RuntimeDiscovery {
  identity: RuntimeIdentity;
  displayName: string;
  version: string;
  distribution: "bundled" | "system" | "remote";
  protocol: string;
}

export interface RuntimeCapabilitySnapshot {
  runtime: RuntimeIdentity;
  base: RuntimeCapabilityLevel;
  contributesToLifeModel: RuntimeCapabilityLevel;
  usesLifeModel: RuntimeCapabilityLevel;
  nativeFeatures: string[];
}

export interface RuntimeDescriptor {
  discovery: RuntimeDiscovery;
  capabilities: RuntimeCapabilitySnapshot;
}

export interface RuntimeConnectionReadiness<TPhase extends string = string> {
  runtime: RuntimeIdentity;
  phase: TPhase;
  commandChannel: "ready" | "not_ready";
  provider: "ready" | "not_ready" | "unknown";
  model: "ready" | "not_ready" | "unknown";
  account: "ready" | "not_ready" | "unknown";
  nativeConfiguration: "runtime_owned";
}

export interface RuntimeSessionBinding {
  runtime: RuntimeIdentity;
  connectionId: string;
  projectPath: string;
  nativeSessionId: string;
}

export interface RuntimeAdapter<
  TStatus,
  TPhase extends string,
  TCommand,
  TResponse,
  TProjectReadiness,
> {
  readonly identity: RuntimeIdentity;
  discover(): Promise<RuntimeDescriptor>;
  connectionReadiness(): Promise<RuntimeConnectionReadiness<TPhase>>;
  status(): Promise<TStatus>;
  send(command: TCommand): Promise<TResponse | void>;
  settleResponse(value: unknown): boolean;
  rejectPending(reason: string): void;
  projectReadiness(projectPath: string): Promise<TProjectReadiness>;
}

export interface ModelReference {
  provider: string;
  id: string;
}

export function hasLoadedModel(
  models: readonly ModelReference[],
  target: ModelReference,
): boolean {
  return models.some(
    (model) => model.provider === target.provider && model.id === target.id,
  );
}

export function readPiModelReferences(response: unknown): ModelReference[] {
  const value = response as {
    success?: unknown;
    data?: { models?: unknown };
  } | null;
  if (value?.success !== true || !Array.isArray(value.data?.models))
    throw new Error("Pi 未返回可核对的运行模型目录。");
  return value.data.models.map((model: unknown) => {
    const item = model as Partial<ModelReference> | null;
    if (typeof item?.provider !== "string" || typeof item.id !== "string")
      throw new Error("Pi 运行模型目录包含无效身份。");
    return { provider: item.provider, id: item.id };
  });
}

// Pi-specific configuration activation. Host lifecycle remains the only owner
// of stopping and reopening the same persistent Session; no prompt is replayed.
export async function selectPiRuntimeModel(
  target: ModelReference,
  options: {
    readModels: () => Promise<readonly ModelReference[]>;
    reloadSession: () => Promise<void>;
    select: (target: ModelReference) => Promise<unknown>;
  },
): Promise<void> {
  if (!hasLoadedModel(await options.readModels(), target)) {
    await options.reloadSession();
    if (!hasLoadedModel(await options.readModels(), target))
      throw new Error(
        `重新加载后 Pi 仍未提供模型 ${target.provider}/${target.id}；未发送模型切换请求。`,
      );
  }
  await options.select(target);
}

/** Service selection, model choice and authentication remain separate facts. */
export const R5_SERVICE_STRINGS = {
  chooseService: "选择一份服务",
  sourceHint: "先选择服务，下一步再选择本次模型。",
  noSavedServices: "尚未保存模型 API 服务。",
  removingServices: "已存模型服务正在移除，暂时无法选用。",
  incompleteServices: "有已存服务待完善。请核对基础地址、接口格式和模型。",
  differentFormat: "已存服务中有接口格式不匹配的配置。",
  supportedFormats: (formats: string) =>
    `此 Agent 可选的接口格式为 ${formats}。`,
  pathEnding: (suffix: string) => `以 ${suffix} 结尾`,
  exactAddress: (endpoint: string) => `使用 ${endpoint}`,
  addressMismatch: (format: string, choices: string) =>
    choices
      ? `请核对服务商提供的 ${format} 基础地址。此 Agent 要求地址${choices}。`
      : `请核对服务商提供的 ${format} 基础地址，当前地址不适用。`,
  addService: "添加模型 API 服务",
  currentAccess: "当前接入",
  method: "模型 API 服务",
  selected: "服务已选择",
  manage: "管理接入",
  changeService: "更换服务",
  editService: "编辑服务",
  changeMethod: "更换接入方式",
  unavailable: "原服务暂不可用，请重新选择。",
  chooseModel: "选择一个模型",
  model: "模型",
  modelHint: "从已选择的 API 服务中选择本次模型。",
  modelUnavailable: "原模型暂不可用，请重新选择。",
} as const;

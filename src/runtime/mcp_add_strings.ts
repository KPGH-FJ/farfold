import { MCP_MANAGEMENT_STRINGS as M } from "./mcp_management_strings";
export const MCP_ADD_STRINGS = {
  ...M,
  heading: "添加本地 MCP",
  open: "添加本地 MCP…",
  form: "本地 MCP 添加内容",
  name: "MCP 名称",
  executable: "程序绝对路径",
  arguments: "按顺序传入的参数",
  argument: "参数",
  addArgument: "添加一个参数",
  removeArgument: "移除参数",
  noArguments: "不传入参数",
  emptyArgument: "空字符串",
  quotedValues: "引号标明值的边界；显示的转义不改变实际内容。",
  inspectButton: "审阅添加",
  confirm: "确认添加并保持停用",
  cancelForm: "收起添加表单",
  invalidated: "输入已变化，原审阅不再可确认。请重新审阅。",
  absent: "所检查范围中尚无此名称",
  inputMissing: "原填写内容已不可用，请重新填写并审阅。",
  inspect: "正在检查名称和写入范围，尚未修改配置。",
  reopen: "查看 MCP 添加状态",
  retired: "此次添加审阅已失效。请重新查询清单并审阅填写内容。",
  verified: "已添加，保持停用。程序、参数和配置报告均已核对。",
  observed: "当前配置与报告符合此次添加内容；不能据此确认此前添加是否成功。",
  mismatch:
    "配置或报告与此次添加内容不同；相同的停用状态也不代表程序和参数一致。",
  requested: "添加后的状态",
  notice:
    "确认后保存所列程序和每项参数，保持停用；会影响以后沿用同一设置的其他对话。不发送消息，不启动填写的程序。",
  effects:
    "官方程序会使用已有配置、登录状态和环境，可能访问网络及维护自身状态。只请求保存此条目，不连接新 MCP。",
  applicability:
    "尚未验证程序能否运行、连接或工具是否可用。不会自动启用、连接或重启对话。",
  guidance: "程序路径和每项参数分别填写，不按命令行拆分；空参数会原样传入。",
  secrets:
    "不要在此填写密码、密钥或其他凭据。确认后这些值会保存在官方配置中；此表单不提供凭据保管。",
  limits:
    "可以添加保持停用的本地程序，或审阅已有用户配置的启用偏好。不办理认证、不测试连接或调用工具。",
  errors: {
    ...M.errors,
    nameConflict: "所检查的配置或清单已有此名称，请换一个名称并重新审阅。",
    invalidName:
      "名称仅限英文字母、数字、点、下划线和短横线，不能包含连续两点或使用保留名称，最多256字节。",
    invalidExecutablePath:
      "请填写准确的绝对程序路径，不使用相对路径、空路径段或受限制的控制或格式字符，最多4096字节。",
    invalidArguments:
      "参数含受限制的控制或格式字符或超过限制；最多64项，每项1024字节，合计16384字节。",
  },
} as const;

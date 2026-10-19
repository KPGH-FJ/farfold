// Owned synthetic SDK fixture only. This module is never selected by production.
import fs from "node:fs/promises";
let calls = 0;
export async function getSessionInfo(id, { dir }) {
  calls++;
  if (mode === "hold" && calls === 2) {
    await fs.writeFile("read-ready", "ready");
    while (true) {
      try {
        await fs.stat("release-read");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }
  return {
    sessionId: mode === "wrong" ? "00000000-0000-0000-0000-000000000001" : id,
    cwd: dir,
    lastModified: mode === "drift" ? calls : 10,
    ...(mode === "missing-size"
      ? {}
      : { fileSize: mode === "too-large" ? 8388609 : 500 }),
  };
}
const read = async (id, options) => {
  if (
    JSON.stringify(options) !==
    JSON.stringify({
      dir: expectedDir,
      offset: 0,
      limit: 401,
      includeSystemMessages: false,
    })
  )
    throw Error("BAD_OPTIONS");
  if (mode === "empty") return [];
  return [
    {
      type: "user",
      uuid: "00000000-0000-0000-0000-000000000001",
      session_id: mode === "wrong-record" ? "wrong" : id,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: { role: "user", content: "😀 Hello" },
    },
    {
      type: "assistant",
      uuid: "00000000-0000-0000-0000-000000000002",
      session_id: id,
      parent_tool_use_id: null,
      parent_agent_id: null,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_TOOL" },
          { type: "tool_result", content: "PRIVATE_TOOL" },
          { type: "text", text: "HELLO" },
        ],
      },
    },
  ];
};
export const getSessionMessages = mode === "unsupported" ? undefined : read;

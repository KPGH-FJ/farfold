import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentHub, agentSourceLabel, preparationProgressKey } from "./AgentHub";
import { AgentSetup, initialAgentSetupProgress } from "./AgentSetup";
import { AgentDetails } from "./AgentDetails";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import {
  ACCESS_STRINGS,
  installationUnavailableLabel,
} from "../runtime/access_strings";
import { R5_PROGRAM_STRINGS } from "../runtime/r5_program_strings";

const card: AgentCardModel = {
  id: "registry:example",
  name: "Example",
  description: "整理资料和日常任务。",
  status: "none",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: "1.2.3",
  source: null,
  installable: true,
  registerable: false,
  custom: false,
  handshake: null,
  platformAvailable: true,
};
function state(cards: AgentCardModel[]): AgentsState {
  return {
    cards,
    connectedCards: cards.filter((item) => item.status === "connected"),
    loading: false,
    loadError: null,
    busy: {},
    scanning: false,
    installProgress: {},
    errors: {},
    install: vi.fn(),
    cancelInstall: vi.fn(),
    selectProgram: vi.fn(),
    selectInstallation: vi.fn(),
    refresh: vi.fn(),
    rescan: vi.fn(),
    connect: vi.fn(),
    reconnect: vi.fn(),
    remove: vi.fn(),
    addCustom: vi.fn(),
  };
}

describe("Agent discovery and preparation", () => {
  it("hides retired catalog entries from discovery and added lists while preserving custom and local choices", () => {
    const deferred = {
      ...card,
      id: "registry:unlisted-example",
      name: "Deferred",
      status: "installed" as const,
      firstBatchVisible: false,
    };
    const agents = state([
      deferred,
      { ...card, name: "Unreviewed", firstBatchVisible: false },
      { ...card, id: "cline", name: "Cline", firstBatchVisible: true },
      {
        ...card,
        id: "fast",
        name: "Fast",
        firstBatchVisible: true,
        authMethods: [],
      },
      {
        ...card,
        id: "custom",
        name: "Custom",
        custom: true,
        status: "installed",
        firstBatchVisible: false,
      },
      {
        ...card,
        id: "local",
        name: "Local",
        source: "discovered",
        status: "installed",
        firstBatchVisible: false,
      },
    ]);
    const props = {
      agents,
      onReturn: () => {},
      onStart: () => {},
      onOpenApi: () => {},
    };
    const discover = renderToStaticMarkup(<AgentHub {...props} />);
    expect(discover).not.toContain("管理设置 · Unreviewed");
    expect(discover).not.toContain("管理设置 · Deferred");
    expect(discover).toContain("管理设置 · Custom");
    expect(discover).toContain("管理设置 · Cline");
    expect(discover).toContain("管理设置 · Fast");
    expect(discover).toContain("管理设置 · Local");
    const added = renderToStaticMarkup(
      <AgentHub {...props} initialView="added" />,
    );
    expect(added).not.toContain("管理设置 · Deferred");
    expect(added).not.toContain("管理设置 · Unreviewed");
    expect(added).toContain("管理设置 · Custom");
    expect(added).toContain("管理设置 · Local");
    expect(agents.cards).toContain(deferred);
    expect(agents.install).not.toHaveBeenCalled();
    expect(agents.remove).not.toHaveBeenCalled();
  });

  it("shows real catalog state without claiming model validation or starting requests", () => {
    const agents = state([
      card,
      { ...card, id: "ready", name: "Ready", status: "connected" },
      { ...card, id: "added", name: "Added", status: "installed" },
    ]);
    const html = renderToStaticMarkup(
      <AgentHub
        agents={agents}
        onReturn={() => {}}
        onStart={() => {}}
        onOpenApi={() => {}}
      />,
    );
    expect(html).toContain("Example");
    expect(html).toContain("未添加");
    expect(html).toContain("未完成设置");
    expect(html).toContain("继续准备");
    expect(html).not.toContain("开始新对话");
    expect(html).toContain("管理设置 · Ready");
    expect(html).not.toContain(">开始对话<");
    expect(html).not.toContain("测试通过");
    expect(html).not.toContain("演示");
    expect(agents.connect).not.toHaveBeenCalled();
    expect(agents.install).not.toHaveBeenCalled();
  });
  it("uses the approved hierarchy while unknown entries keep honest description and no guessed tags", () => {
    const agents = state([
      {
        ...card,
        description:
          "An autonomous coding Agent 接入 with research superpowers",
        sourceUrl: "https://docs.example.test/agent",
      },
    ]);
    const html = renderToStaticMarkup(
      <AgentHub
        agents={agents}
        onReturn={() => {}}
        onStart={() => {}}
        onOpenApi={() => {}}
        onCustom={() => {}}
      />,
    );
    expect(html).toContain("找到适合这项工作的 Agent");
    expect(html).toContain("选一个 Agent 开始工作，也可以在这里安装和管理。");
    expect(html).toContain("我的 Agent");
    expect(html).toContain("docs.example.test");
    expect(html).toContain("可以在这里安装，连接后选择使用方式与模型。");
    expect(html).not.toContain("superpowers");
    expect(html).not.toContain("全部来源");
    expect(html).not.toContain("全部安装方式");
    expect(html).toContain('aria-label="按用途筛选"');
    expect(html).not.toContain("<span>研究</span>");
    expect(html).not.toContain("agent-hub-heading-stat");
    expect(html).not.toContain("btn-primary");
    expect(html).toContain('aria-label="管理设置 · Example"');
    expect(html).toMatch(
      /<button[^>]*agent-hub-detail-button[^>]*>[^]*?管理设置<\/button>/,
    );
  });
  it("restores a category with its search and shows only matching reviewed cards", () => {
    const agents = state([
      card,
      {
        ...card,
        id: "reviewed",
        name: "Reviewed",
        presentation: {
          publisher: "Example Project",
          description: "精简的编程工具。",
          categories: ["编程", "轻量"],
          sourceUrl: "https://example.test/official",
        },
      },
    ]);
    const html = renderToStaticMarkup(
      <AgentHub
        agents={agents}
        onReturn={() => {}}
        onStart={() => {}}
        onOpenApi={() => {}}
        restoredState={{
          selected: null,
          detail: null,
          intent: "use",
          view: "discover",
          query: "reviewed",
          source: "all",
          availability: "all",
          category: "轻量",
        }}
      />,
    );
    expect(html).toContain("Reviewed");
    expect(html).toContain("精简的编程工具。");
    expect(html).toContain("<span>轻量</span>");
    expect(html).toContain("1 个 Agent");
    expect(html).not.toContain("查看详情 · Example");
    expect(html).toContain("agent-hub-category active");
    expect(agents.connect).not.toHaveBeenCalled();
  });
  it("keeps unsupported platforms discoverable without offering an installation action", () => {
    const unsupported = {
      ...card,
      installable: false,
      platformAvailable: false,
    };
    const agents = state([unsupported]);
    const hub = renderToStaticMarkup(
      <AgentHub
        agents={agents}
        onReturn={() => {}}
        onStart={() => {}}
        onOpenApi={() => {}}
      />,
    );
    expect(hub).toContain("官方未提供此设备的安装方式");
    const setup = renderToStaticMarkup(
      <AgentSetup
        card={unsupported}
        agents={agents}
        onClose={() => {}}
        onStart={() => {}}
        onOpenApi={() => {}}
        progress={{ step: 0, choice: "existing" }}
        onProgress={() => {}}
      />,
    );
    expect(setup).toContain(installationUnavailableLabel(false));
    expect(setup).not.toMatch(/<button[^>]*>安装程序<\/button>/);
    expect(agents.connect).not.toHaveBeenCalled();
  });
  it.each([true, null, undefined])(
    "keeps an unsupported installer distinct from platform support (%s) in every entry",
    (platformAvailable) => {
      const unavailable = {
        ...card,
        installable: false,
        platformAvailable,
        installGuide: "https://example.test",
        sourceUrl: "https://example.test",
      };
      const agents = state([unavailable]);
      const hub = renderToStaticMarkup(
        <AgentHub
          agents={agents}
          onReturn={() => {}}
          onStart={() => {}}
          onOpenApi={() => {}}
        />,
      );
      const detail = renderToStaticMarkup(
        <AgentDetails
          card={unavailable}
          agents={agents}
          active
          source="官方目录"
          onClose={() => {}}
          onPrepare={() => {}}
        />,
      );
      const setup = renderToStaticMarkup(
        <AgentSetup
          card={unavailable}
          agents={agents}
          onClose={() => {}}
          onStart={() => {}}
          onOpenApi={() => {}}
          progress={{ step: 0, choice: "existing" }}
          onProgress={() => {}}
        />,
      );
      for (const html of [hub, detail, setup]) {
        expect(html).toContain(installationUnavailableLabel(platformAvailable));
        expect(html).not.toContain("暂不支持此设备");
        expect(html).not.toContain("官方未提供此设备");
      }
      expect(detail).toContain("官方说明");
      expect(setup).toContain(R5_PROGRAM_STRINGS.officialGuide);
      expect(setup).toMatch(
        new RegExp(
          `<button(?![^>]*disabled)[^>]*>${R5_PROGRAM_STRINGS.officialGuide}</button>`,
        ),
      );
      expect(setup).not.toMatch(/<button[^>]*>安装程序<\/button>/);
      expect(agents.install).not.toHaveBeenCalled();
      expect(agents.connect).not.toHaveBeenCalled();
    },
  );
  it("does not mark an already added program as unsupported because directory installation is unavailable", () => {
    const installed = {
      ...card,
      status: "installed" as const,
      installable: false,
      platformAvailable: false,
    };
    const html = renderToStaticMarkup(
      <AgentDetails
        card={installed}
        agents={state([installed])}
        active
        source="官方目录"
        onClose={() => {}}
        onPrepare={() => {}}
      />,
    );
    expect(html).not.toContain("暂不支持此设备");
    expect(html).not.toContain("官方未提供此设备");
    expect(html).toContain("未完成设置");
  });
  it("keeps preparation choices with their original Agent, folder and source", () => {
    const selection = {
      service: null,
      config: { model: "chosen-model", reasoning: "ultra" },
    };
    expect(initialAgentSetupProgress(selection, true)).toEqual({
      step: 2,
      choice: "existing",
      selection,
      accessStage: "method",
    });
    const context = { agentId: card.id, cwd: "/draft-folder", selection };
    expect(preparationProgressKey(card.id, context)).not.toBe(
      preparationProgressKey(card.id, { ...context, cwd: "/other-folder" }),
    );
    expect(preparationProgressKey("other-agent", context)).toBe(
      preparationProgressKey("other-agent", {
        ...context,
        selection: undefined,
      }),
    );
    const api = {
      service: { id: "saved-service", revision: "r1", model: "selected-model" },
      config: {},
    };
    expect(initialAgentSetupProgress(api, true)).toEqual({
      step: 2,
      choice: "api",
      selection: api,
      accessStage: "api",
    });
    expect(
      preparationProgressKey(card.id, { ...context, selection: api }),
    ).not.toBe(preparationProgressKey(card.id, context));
  });
  it("offers shared preparation tabs and an optional test without claiming an untested setup is usable", () => {
    const connected = { ...card, status: "connected" as const };
    const html = renderToStaticMarkup(
      <AgentSetup
        card={connected}
        agents={state([connected])}
        cwd="/draft-folder"
        returnLabel="返回原草稿"
        onClose={() => {}}
        onStart={() => {}}
        onOpenApi={() => {}}
        progress={{
          step: 2,
          choice: "existing",
          selection: { service: null, config: { model: "chosen" } },
        }}
        onProgress={() => {}}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain("账号与服务");
    expect(html).toContain("模型");
    expect(html).toContain("程序");
    expect(html).not.toContain("确认使用");
    expect(html).toContain("/draft-folder");
    expect(html).toContain("发送一条短消息测试（可选）");
    expect(html).toContain(ACCESS_STRINGS.testNotRun);
    expect(html).toContain("返回原草稿");
    expect(html).not.toContain("准备完成，可以开始对话");
    expect(html).not.toContain("短消息测试通过");
    expect(html).not.toContain("选择与测试");
  });
  it("distinguishes locally discovered, official directory, and custom entries", () => {
    expect(agentSourceLabel(card)).toBe("官方目录");
    expect(agentSourceLabel({ ...card, status: "discovered" })).toBe(
      "本机发现",
    );
    expect(agentSourceLabel({ ...card, custom: true, source: "custom" })).toBe(
      "自定义",
    );
  });
  it("keeps discovery and setup copy free from internal vocabulary", () => {
    const forbidden =
      /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i;
    for (const value of Object.values(ACCESS_STRINGS)) {
      const text =
        typeof value === "function"
          ? (value as (arg: never) => string)(2 as never)
          : value;
      expect(Array.isArray(text) ? text.join(" ") : text).not.toMatch(
        forbidden,
      );
    }
  });
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url =
  process.env.PI_WORKSPACE_FIXTURE_URL ??
  "http://127.0.0.1:1427/scripts/fixtures/pi-acp-workspace.html";
const output = resolve(
  process.env.PI_WORKSPACE_QA_OUTPUT ??
    "src-tauri/target/d-stage-pi-candidate-0912/frontend-smoke",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
try {
  const coldIdle = process.env.PI_WORKSPACE_SCENARIO === "idle-crash-cold";
  const nativeAuth =
    process.env.PI_WORKSPACE_SCENARIO?.startsWith("native-auth");
  const authFailure =
    process.env.PI_WORKSPACE_SCENARIO === "native-auth-failure";
  const authCancel = process.env.PI_WORKSPACE_SCENARIO === "native-auth-cancel";
  const authLogout = process.env.PI_WORKSPACE_SCENARIO === "native-auth-logout";
  const authSelect = process.env.PI_WORKSPACE_SCENARIO === "native-auth-select";
  const staleList =
    process.env.PI_WORKSPACE_SCENARIO?.startsWith("managed-stale-list");
  const providerApply =
    process.env.PI_WORKSPACE_SCENARIO?.startsWith("provider-apply");
  const applyFailure =
    process.env.PI_WORKSPACE_SCENARIO === "provider-apply-failure";
  await page.goto(
    nativeAuth
      ? `${url}${authFailure ? "?auth-failure=1" : ""}`
      : coldIdle
        ? `${url}?idle-on-start=1`
        : staleList
          ? `${url}?delayed-list=1`
          : providerApply
            ? `${url}?apply-mode=1${applyFailure ? "&apply-failure=1" : ""}`
            : url,
  );
  if (!coldIdle)
    await page.getByText("RESTORED ACP HISTORY", { exact: true }).waitFor();
  const input = page.getByRole("textbox", { name: "输入消息" });
  await page.waitForFunction(
    () => document.querySelector("textarea")?.value === "RESTORED ACP DRAFT",
  );
  if (nativeAuth) {
    await page
      .getByRole("button", { name: "打开命令面板", exact: true })
      .click();
    await page.getByText("打开模型与 Provider", { exact: true }).click();
    await page.getByRole("tab", { name: "原生账号", exact: true }).click();
    await page
      .getByRole("button", { name: "原生 API key", exact: true })
      .click();
    const secret = page.getByLabel("原生密钥", { exact: true });
    await secret.waitFor();
    assert.equal(await secret.getAttribute("type"), "password");
    assert.equal(
      await page
        .getByRole("tab", { name: "托管连接", exact: true })
        .isDisabled(),
      true,
    );
    await secret.fill("synthetic-auth-secret");
    if (authCancel) {
      await page.getByRole("button", { name: "取消登录", exact: true }).click();
      await page
        .getByText("凭据是否改变尚未确认；请断开并恢复当前对话", {
          exact: true,
        })
        .waitFor();
    } else {
      await page.getByRole("button", { name: "继续", exact: true }).click();
      await page
        .getByText(
          authFailure
            ? "凭据已保存，刷新未确认；请断开并恢复当前对话"
            : "凭据已保存，Pi 已刷新；尚未验证模型请求",
          { exact: true },
        )
        .waitFor();
    }
    assert.equal(await secret.count(), 0);
    if (authLogout) {
      await page
        .getByRole("button", { name: "返回登录方式", exact: true })
        .click();
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await page
        .getByRole("button", { name: "确认退出 Anthropic", exact: true })
        .click();
      await page
        .getByText("已移除保存的凭据，Pi 已刷新", { exact: true })
        .waitFor();
    }
    assert.equal(
      await page.getByText("synthetic-auth-secret", { exact: false }).count(),
      0,
    );
    const calls = await page.evaluate(() => window.piFixture.calls);
    const authCalls = calls.filter(
      (call) => call.command === "pi_acp_native_auth",
    );
    assert.equal(
      authCalls.filter((call) => call.args.input.command.action === "start")
        .length,
      authLogout ? 2 : 1,
    );
    assert.equal(
      authCalls.filter((call) => call.args.input.command.action === "reply")
        .length,
      authCancel ? 0 : 1,
    );
    for (const call of authCalls) {
      assert.equal(call.args.input.nativeSessionId, "fixture-native");
      assert.equal(call.args.input.runtimeGeneration, 9);
    }
    assert.equal(
      calls.some((call) =>
        [
          "host_pi_acp_turn_submit",
          "managed_provider_api_key_save",
          "managed_provider_apply_pi",
          "runtime_send",
        ].includes(call.command),
      ),
      false,
    );
    assert.equal(await input.inputValue(), "RESTORED ACP DRAFT");
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page
        .locator(".pi-provider-settings-body")
        .evaluate((body) => ({
          overflow: body.scrollWidth - body.clientWidth,
        }));
      assert.ok(geometry.overflow <= 1);
      await page.screenshot({
        path: resolve(
          output,
          `${process.env.PI_WORKSPACE_SCENARIO}-${width}.png`,
        ),
      });
    }
    if (authFailure || authCancel) {
      await page
        .getByRole("button", { name: "断开 Pi 并核验恢复", exact: true })
        .last()
        .click();
      await page.waitForFunction(() =>
        window.piFixture.calls.some(
          (call) => call.command === "host_managed_runtime_stop",
        ),
      );
    }
    if (authSelect) {
      await page
        .getByRole("button", { name: "关闭 Pi 设置", exact: true })
        .click();
      await page.locator(".model-trigger").click();
      await page.getByRole("button", { name: /Native Fixture Model/ }).click();
      await page
        .locator(".model-trigger")
        .getByText("Native Fixture Model", { exact: true })
        .waitFor();
      await input.fill("Native source fixture task");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.getByText("LIVE ACP TEXT", { exact: true }).waitFor();
      await page.evaluate(() => window.piFixture.finish("accepted"));
      await page.getByRole("button", { name: "发送", exact: true }).waitFor();
      const selectedCalls = await page.evaluate(() => window.piFixture.calls);
      const selection = selectedCalls.filter(
        (call) => call.command === "pi_acp_set_config_option",
      );
      assert.equal(selection.length, 1);
      assert.deepEqual(selection[0].args.input, {
        farfoldSessionId: "fixture-host",
        nativeSessionId: "fixture-native",
        runtimeGeneration: 9,
        configId: "model",
        value: "anthropic/native-fixture-model",
      });
      assert.equal(
        selectedCalls.filter(
          (call) => call.command === "host_pi_acp_turn_submit",
        ).length,
        1,
      );
      assert.equal(
        selectedCalls.some((call) =>
          [
            "managed_provider_apply_pi",
            "host_session_create",
            "runtime_send",
          ].includes(call.command),
        ),
        false,
      );
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({
          path: resolve(output, `native-selection-${width}.png`),
        });
      }
    }
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        scenario: process.env.PI_WORKSPACE_SCENARIO,
        modelRequests: 0,
        nativeProcesses: 0,
      }),
    );
  } else if (providerApply) {
    const openSettings = async () => {
      await page
        .getByRole("button", { name: "打开命令面板", exact: true })
        .click();
      await page.getByText("打开模型与 Provider", { exact: true }).click();
      await page
        .getByRole("heading", { name: "当前 Provider", exact: true })
        .waitFor();
    };
    await openSettings();
    await page.getByText("Pi 请求已验证", { exact: true }).waitFor();
    await page.getByLabel("Model ID", { exact: true }).fill("fixture-model");
    await page
      .getByLabel("API key", { exact: true })
      .fill("fixture-only-not-a-real-key");
    await page
      .getByRole("button", { name: "保存共享连接", exact: true })
      .click();
    const apply = page.getByRole("button", {
      name: "应用到当前对话",
      exact: true,
    });
    await page.waitForFunction(
      () => document.querySelector('input[type="password"]')?.value === "",
    );
    await apply.scrollIntoViewIfNeeded();
    await apply.click();
    await page.waitForFunction(() =>
      window.piFixture.calls.some(
        (call) => call.command === "pi_acp_apply_provider",
      ),
    );
    if (applyFailure) {
      await page
        .getByText("FIXTURE APPLY UNKNOWN", { exact: false })
        .first()
        .waitFor();
      assert.equal(
        await page.locator("dl").getByText("v1", { exact: true }).count(),
        1,
      );
      await page
        .getByText("配置结果未知，当前模型未确认", { exact: true })
        .waitFor();
      await page.getByText("上次确认模型", { exact: true }).waitFor();
      assert.equal(await apply.isDisabled(), true);
      assert.equal(
        await page.getByText("Pi 请求已验证", { exact: true }).count(),
        0,
      );
    } else {
      await page
        .getByRole("heading", { name: "当前 Provider", exact: true })
        .waitFor({ state: "hidden" });
      await openSettings();
      await page.locator("dl").getByText("v2", { exact: true }).waitFor();
    }
    const calls = await page.evaluate(() => window.piFixture.calls);
    const applies = calls.filter(
      (call) => call.command === "pi_acp_apply_provider",
    );
    assert.equal(applies.length, 1);
    assert.deepEqual(applies[0].args.input, {
      farfoldSessionId: "fixture-host",
      nativeSessionId: "fixture-native",
      runtimeGeneration: 9,
      provider: {
        providerConnectionId: "fixture-provider-b",
        providerConfigVersionId: "v2",
      },
    });
    assert.equal(
      calls.some((call) =>
        [
          "host_session_create",
          "host_session_open",
          "host_managed_runtime_stop",
          "managed_provider_apply_pi",
          "host_pi_acp_turn_submit",
        ].includes(call.command),
      ),
      false,
    );
    assert.equal(await input.inputValue(), "RESTORED ACP DRAFT");
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => {
        document.querySelector(".pi-provider-settings-body").scrollTop = 0;
        const identity = document
          .querySelector("dialog .context-identities")
          .getBoundingClientRect();
        const form = document
          .querySelector("dialog form")
          .getBoundingClientRect();
        const body = document.querySelector(".pi-provider-settings-body");
        return {
          metadataBottom: identity.bottom,
          formTop: form.top,
          overflowX: body.scrollWidth - body.clientWidth,
        };
      });
      assert.ok(
        geometry.metadataBottom <= geometry.formTop,
        "Provider metadata must not overlap the form",
      );
      assert.ok(
        geometry.overflowX <= 1,
        "Provider body must not overflow horizontally",
      );
      await page.screenshot({
        path: resolve(
          output,
          `${process.env.PI_WORKSPACE_SCENARIO}-${width}.png`,
        ),
      });
    }
    assert.deepEqual(pageErrors, []);
    console.log(
      JSON.stringify({
        result: "passed",
        scenario: process.env.PI_WORKSPACE_SCENARIO,
        checks: [
          "same-session-apply",
          "no-restart-or-prompt",
          "draft-preserved",
          applyFailure ? "unknown-keeps-source" : "confirmed-version",
        ],
        modelRequests: 0,
        nativeProcesses: 0,
        output,
      }),
    );
  } else if (process.env.PI_WORKSPACE_SCENARIO?.startsWith("managed-")) {
    let calls;
    const refreshFailure =
      process.env.PI_WORKSPACE_SCENARIO === "managed-refresh-failure" ||
      process.env.PI_WORKSPACE_SCENARIO ===
        "managed-stale-list-refresh-failure";
    const createFailure =
      process.env.PI_WORKSPACE_SCENARIO === "managed-create-failure";
    await page.getByRole("button", { name: "新对话", exact: true }).click();
    await page
      .getByRole("heading", { name: "Pi 新对话", exact: true })
      .waitFor();
    if (!staleList) {
      await page
        .getByRole("button", { name: "关闭 Pi 设置", exact: true })
        .click();
      calls = await page.evaluate(() => window.piFixture.calls);
      assert.equal(
        calls.some((call) =>
          ["host_managed_runtime_stop", "host_session_create"].includes(
            call.command,
          ),
        ),
        false,
      );
      assert.equal(await input.inputValue(), "RESTORED ACP DRAFT");
      await page.getByRole("button", { name: "新对话", exact: true }).click();
    }
    await page.getByLabel("Model ID", { exact: true }).fill("fixture-model");
    await page
      .getByRole("combobox", { name: "API 协议", exact: true })
      .selectOption("openai-responses");
    await page
      .getByLabel("API key", { exact: true })
      .fill("fixture-only-not-a-real-key");
    await page.evaluate(() => window.piFixture.rejectProviderSave(true));
    await page
      .getByRole("button", { name: "保存共享连接", exact: true })
      .click();
    await page.getByText("FIXTURE SAVE REJECTED", { exact: false }).waitFor();
    assert.equal(
      await page.getByLabel("API key", { exact: true }).inputValue(),
      "fixture-only-not-a-real-key",
    );
    await page.evaluate(() => window.piFixture.rejectProviderSave(false));
    if (refreshFailure)
      await page.evaluate(() => window.piFixture.rejectListAfterSave());
    await page
      .getByRole("button", { name: "保存共享连接", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector('input[type="password"]')?.value === "",
    );
    if (refreshFailure) {
      await page
        .getByRole("alert")
        .filter({ hasText: "连接已保存，但列表刷新失败" })
        .waitFor();
      if (staleList) {
        await page.evaluate(() => window.piFixture.releaseFirstList());
        await page.waitForTimeout(100);
      }
      assert.equal(
        await page
          .getByRole("button", { name: "应用到新对话", exact: true })
          .isDisabled(),
        true,
      );
      await page
        .getByRole("button", { name: "关闭 Pi 设置", exact: true })
        .click();
      await page.getByRole("button", { name: "新对话", exact: true }).click();
    } else if (staleList) {
      await page.waitForFunction(
        () => !document.querySelector("dialog select")?.disabled,
      );
      await page.evaluate(() => window.piFixture.releaseFirstList());
      await page.waitForTimeout(100);
    }
    calls = await page.evaluate(() => window.piFixture.calls);
    assert.equal(
      calls
        .filter((call) => call.command === "managed_provider_api_key_save")
        .at(-1).args.input.apiKind,
      "openai-responses",
    );
    assert.equal(
      calls.some((call) =>
        ["host_managed_runtime_stop", "host_session_create"].includes(
          call.command,
        ),
      ),
      false,
    );
    await page
      .getByRole("button", { name: "应用到新对话", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(output, "04-shared-provider-form.png"),
    });
    await page.setViewportSize({ width: 900, height: 760 });
    await page.getByLabel("API key", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(output, "04b-shared-provider-900.png"),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (createFailure)
      await page.evaluate(() => window.piFixture.rejectNextCreate());
    await page
      .getByRole("button", { name: "应用到新对话", exact: true })
      .click();
    await page.waitForFunction(() =>
      window.piFixture.calls.some(
        (call) => call.command === "host_session_create",
      ),
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.piFixture.calls.find(
            (call) => call.command === "host_session_create",
          ).args.input.options.managedProvider.providerConfigVersionId,
      ),
      "v2",
    );
    if (createFailure) {
      await page
        .getByText("FIXTURE CREATE REJECTED", { exact: false })
        .waitFor();
      await page.getByRole("button", { name: "继续对话", exact: true }).click();
      await page.getByText("RESTORED ACP HISTORY", { exact: true }).waitFor();
      await page.waitForFunction(
        () => !document.querySelector(".composer textarea")?.disabled,
      );
      assert.equal(await input.inputValue(), "RESTORED ACP DRAFT");
      const failureCalls = await page.evaluate(() => window.piFixture.calls);
      assert.equal(
        failureCalls.filter((call) => call.command === "host_session_create")
          .length,
        1,
      );
      const opens = failureCalls.filter(
        (call) => call.command === "host_session_open",
      );
      assert.equal(opens.length, 1);
      assert.equal(opens[0].args.input.farfoldSessionId, "fixture-host");
      assert.equal(
        failureCalls.some((call) =>
          [
            "runtime_send",
            "host_pi_turn_submit",
            "host_pi_acp_turn_submit",
          ].includes(call.command),
        ),
        false,
      );
      assert.deepEqual(pageErrors, []);
      console.log(
        JSON.stringify({
          result: "passed",
          scenario: "managed-create-failure-original-reopen",
          modelRequests: 0,
          nativeProcesses: 0,
        }),
      );
    } else {
      await page.waitForFunction(
        () =>
          document.querySelector(".send-button") !== null &&
          !document.querySelector(".composer textarea")?.disabled &&
          !document.querySelector("dialog[open]"),
      );
      calls = await page.evaluate(() => window.piFixture.calls);
      const create = calls.filter(
        (call) => call.command === "host_session_create",
      );
      assert.equal(create.length, 1);
      assert.equal(
        create[0].args.input.connectionId,
        "pi-acp-managed-local-v1",
      );
      assert.deepEqual(create[0].args.input.options.managedProvider, {
        providerConnectionId: "fixture-provider",
        providerConfigVersionId: "v2",
      });
      assert.equal(create[0].args.input.options.adapterId, "pi-acp-stdio-v1");
      assert.equal(
        calls.filter((call) => call.command === "host_managed_runtime_stop")
          .length,
        1,
      );
      assert.equal(
        calls.some((call) =>
          [
            "managed_provider_apply_pi",
            "runtime_send",
            "host_pi_turn_submit",
            "host_pi_acp_turn_submit",
          ].includes(call.command),
        ),
        false,
      );
      assert.equal(await input.inputValue(), "");
      assert.equal(
        await page.evaluate(() => window.piFixture.getDraft("fixture-host")),
        "RESTORED ACP DRAFT",
      );
      assert.deepEqual(pageErrors, []);
      await page.screenshot({
        path: resolve(output, "05-new-managed-session.png"),
      });
      console.log(
        JSON.stringify(
          {
            result: "passed",
            scenario: process.env.PI_WORKSPACE_SCENARIO,
            checks: [
              ...(!staleList
                ? ["cancel-no-mutation"]
                : ["stale-list-invalidated"]),
              ...(refreshFailure ? ["refresh-failure-no-stale-revival"] : []),
              "save-failure-retains-input",
              "save-success-clears-key",
              "save-not-apply",
              "selected-version-create-once",
              "old-draft-preserved",
              "no-native-fallback",
            ],
            modelRequests: 0,
            nativeProcesses: 0,
          },
          null,
          2,
        ),
      );
    }
  } else if (process.env.PI_WORKSPACE_SCENARIO?.startsWith("idle-crash")) {
    if (!coldIdle) await page.evaluate(() => window.piFixture.idleCrash());
    await page
      .getByRole("button", { name: "断开 Pi 并核验恢复", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.piFixture.calls.some(
          (call) => call.command === "host_managed_runtime_stop",
        ),
      undefined,
      { timeout: 3000 },
    );
    const stops = await page.evaluate(() =>
      window.piFixture.calls.filter(
        (call) => call.command === "host_managed_runtime_stop",
      ),
    );
    assert.deepEqual(stops[0].args.input.session, {
      farfoldSessionId: "fixture-host",
      nativeSessionId: "fixture-native",
      runtimeGeneration: 9,
    });
    await page.getByRole("button", { name: "继续对话", exact: true }).click();
    await page.getByText("RESTORED ACP HISTORY", { exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".send-button")?.disabled,
    );
    assert.equal(await input.inputValue(), "RESTORED ACP DRAFT");
    const calls = await page.evaluate(() => window.piFixture.calls);
    assert.equal(
      calls.filter((call) => call.command === "host_session_open").length,
      1,
    );
    assert.equal(
      calls.some((call) =>
        [
          "runtime_send",
          "runtime_status",
          "host_pi_turn_submit",
          "host_pi_acp_turn_submit",
        ].includes(call.command),
      ),
      false,
    );
    assert.deepEqual(pageErrors, []);
    await page.screenshot({
      path: resolve(output, "03-idle-crash-reopened.png"),
    });
    console.log(
      JSON.stringify(
        {
          result: "passed",
          scenario: `${coldIdle ? "cold-" : ""}idle-crash-original-session-reopen`,
          modelRequests: 0,
          nativeProcesses: 0,
        },
        null,
        2,
      ),
    );
  } else {
    await page.getByTitle("选择 Pi 模型", { exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "设为默认", exact: true }).count(),
      0,
    );
    await page.getByRole("button", { name: "high", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".thinking-control button.active")
          ?.textContent === "high",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("LIVE ACP TEXT", { exact: true }).waitFor();
    await input.fill("DO NOT CLEAR THIS NEW DRAFT");
    await page.getByRole("button", { name: "发送转向", exact: true }).waitFor();
    assert.equal(await input.inputValue(), "DO NOT CLEAR THIS NEW DRAFT");
    await page.evaluate(() =>
      window.piFixture.native(
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "STALE MUST NOT RENDER",
          },
        },
        true,
      ),
    );
    assert.equal(
      await page.getByText("STALE MUST NOT RENDER", { exact: false }).count(),
      0,
    );
    await input.fill("STEER EXACT TURN");
    await page.getByRole("button", { name: "发送转向", exact: true }).click();
    await page
      .getByText("Pi 已接收插话并加入原生队列，尚不代表已执行。", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: "跟进", exact: true }).click();
    await input.fill("FOLLOW UP SAME TURN");
    await page.getByRole("button", { name: "加入跟进", exact: true }).click();
    await page
      .getByText("Pi 已接收 follow-up 并加入原生队列，尚不代表已执行。", {
        exact: true,
      })
      .waitFor();
    await page.evaluate(() => window.piFixture.dialog());
    await page.getByRole("button", { name: "否", exact: true }).click();
    await page
      .getByRole("heading", { name: "FIXTURE DIALOG" })
      .waitFor({ state: "hidden" });
    await page.evaluate(() => window.piFixture.dialog("input"));
    await page.getByRole("button", { name: "提交", exact: true }).click();
    await page
      .getByRole("heading", { name: "FIXTURE DIALOG" })
      .waitFor({ state: "hidden" });
    await page.evaluate(() => window.piFixture.dialog("editor"));
    await page
      .getByRole("button", { name: "取消", exact: true })
      .last()
      .click();
    await page
      .getByRole("heading", { name: "FIXTURE DIALOG" })
      .waitFor({ state: "hidden" });
    let calls = await page.evaluate(() => window.piFixture.calls);
    assert.equal(
      calls.filter((call) => call.command === "host_pi_acp_turn_submit").length,
      1,
    );
    const intervention = calls.find(
      (call) => call.command === "host_pi_acp_intervene",
    ).args.input;
    assert.ok(intervention.turnId);
    assert.equal(intervention.nativeSessionId, "fixture-native");
    assert.deepEqual(
      calls.find((call) => call.command === "pi_acp_respond_dialog").args.input
        .answer,
      { kind: "confirm", confirmed: false },
    );
    const answers = calls
      .filter((call) => call.command === "pi_acp_respond_dialog")
      .map((call) => call.args.input.answer);
    assert.deepEqual(answers, [
      { kind: "confirm", confirmed: false },
      { kind: "text", value: "" },
      { kind: "cancel" },
    ]);
    const interventions = calls
      .filter((call) => call.command === "host_pi_acp_intervene")
      .map((call) => call.args.input);
    assert.deepEqual(
      interventions.map((item) => item.kind),
      ["steer", "follow_up"],
    );
    assert.equal(interventions[0].turnId, interventions[1].turnId);
    assert.deepEqual(
      calls.find((call) => call.command === "pi_acp_set_config_option").args
        .input,
      {
        farfoldSessionId: "fixture-host",
        nativeSessionId: "fixture-native",
        runtimeGeneration: 9,
        configId: "thought_level",
        value: "high",
      },
    );
    await input.fill("KEEP ON STOP");
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await page.getByText("FINAL ACP RESULT", { exact: true }).waitFor();
    await page.getByRole("button", { name: "发送", exact: true }).waitFor();
    assert.equal(await input.inputValue(), "KEEP ON STOP");
    await page.screenshot({ path: resolve(output, "01-recovered-1440.png") });
    await input.fill("UNKNOWN TURN");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByText("LIVE ACP TEXT", { exact: true }).waitFor();
    await page.evaluate(() => window.piFixture.finish("unknown"));
    await page
      .getByText("Pi 本轮结果未确认，工作区占用仍保留。", { exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "断开 Pi 并核验恢复", exact: true })
      .click();
    await page.getByText("Pi 未启动", { exact: true }).waitFor();
    calls = await page.evaluate(() => window.piFixture.calls);
    const recovery = calls.find(
      (call) => call.command === "host_managed_runtime_stop",
    ).args.input.recovery;
    assert.equal(recovery.nativeSessionId, "fixture-native");
    assert.ok(recovery.turnId);
    assert.equal(
      calls.filter((call) => call.command === "host_pi_acp_turn_submit").length,
      2,
    );
    assert.equal(
      calls.some((call) =>
        [
          "runtime_send",
          "runtime_status",
          "host_pi_turn_submit",
          "host_pi_turn_abort",
        ].includes(call.command),
      ),
      false,
    );
    assert.deepEqual(pageErrors, []);
    await page.setViewportSize({ width: 900, height: 760 });
    await page.screenshot({ path: resolve(output, "02-recovery-900.png") });
    console.log(
      JSON.stringify(
        {
          result: "passed",
          assertions: [
            "restore",
            "draft-race",
            "live-stream",
            "stale-event",
            "steer-single-prompt",
            "confirm-false",
            "empty-text",
            "cancel",
            "follow-up-same-turn",
            "thinking-config",
            "stop",
            "unknown-recovery",
            "no-rpc-fallback",
          ],
          modelRequests: 0,
          nativeProcesses: 0,
          output,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await browser.close();
}

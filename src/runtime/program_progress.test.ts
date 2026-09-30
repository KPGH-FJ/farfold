import { expect, it } from "vitest";
import { programProgress } from "./program_progress";
import { STRINGS } from "./strings";

it("distinguishes zero received bytes from no measurement without inventing a total", () => {
  expect(
    programProgress("install", { stage: "download", bytes: 0, total: null })
      ?.label,
  ).toBe("下载中… 已下载 0 B");
  expect(
    programProgress("install", { stage: "download", bytes: null, total: 1024 })
      ?.label,
  ).toBe(STRINGS.install.stages.download);
});

it("keeps valid received bytes when the total is unavailable or inconsistent", () => {
  for (const total of [
    null,
    0,
    -1,
    100,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    const progress = programProgress("install", {
      stage: "download",
      bytes: 1024,
      total,
    });
    expect(progress?.label).toBe("下载中… 已下载 1 KiB");
    expect(progress?.canCancelInstall).toBe(true);
  }
});

it("does not present an invalid received count or leftover sizes as a current measurement", () => {
  for (const bytes of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(
      programProgress("install", { stage: "download", bytes, total: null })
        ?.label,
    ).toBe(STRINGS.install.stages.download);
  }
  const leftover = { stage: "download", bytes: 1024, total: 2048 };
  expect(programProgress("connect", leftover)).toEqual({
    label: STRINGS.agents.connecting,
    canCancelInstall: false,
  });
  expect(programProgress(null, leftover)).toBeNull();
});

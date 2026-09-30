import { expect, it } from "vitest";
import {
  publicModelValue,
  reviewedInstallationInput,
  type InstallationOptions,
} from "./installation_input";
const options: InstallationOptions = {
  declarationId: "model-v1",
  registryVersion: "1.0.0",
  launch: { kind: "uvx", package: "fixture==1.0.0", args: ["-x"] },
  fields: [
    {
      id: "model",
      label: "模型",
      argument: "--model",
      required: false,
      valueKind: "model",
      sourceUrl: "https://example.com/model",
    },
  ],
};
it("treats omission as existing settings and shows the current explicit model on reinstall", () => {
  expect(reviewedInstallationInput(options)?.values).toEqual({});
  expect(
    reviewedInstallationInput({
      ...options,
      currentValues: { model: "$system.chosen" },
    })?.values,
  ).toEqual({ model: "$system.chosen" });
  expect(
    reviewedInstallationInput(
      { ...options, currentValues: { model: "$system.chosen" } },
      { ...options, values: { model: "" } },
    )?.values,
  ).toEqual({});
});
it("never converts an invalid optional model into inherited settings", () => {
  const input = { ...options, values: { model: "contains spaces" } };
  expect(reviewedInstallationInput(options, input)).toBeNull();
});
it("requires new input after declared version or original arguments change", () => {
  const input = { ...options, values: { model: "$system.chosen" } };
  expect(
    reviewedInstallationInput({ ...options, registryVersion: "2.0.0" }, input),
  ).toBeNull();
  expect(
    reviewedInstallationInput(
      { ...options, launch: { ...options.launch, args: ["-x", "--new"] } },
      input,
    ),
  ).toBeNull();
});
it.each([
  "$system.chosen",
  "provider:model-v1",
  "provider/model_1",
  "model+thinking",
])("retains a supported public model literally: %s", (value) =>
  expect(publicModelValue(value)).toBe(true),
);
it.each([
  "sk-private",
  "sk_private",
  "https://example.com/model",
  "name?api_key=value",
  "name@host",
  "name extra",
  "$system.bad.name",
  "-option",
  " leading",
  "trailing ",
  "line\nvalue",
])(
  "rejects unsupported or secret-like model input without trimming: %s",
  (value) => expect(publicModelValue(value)).toBe(false),
);

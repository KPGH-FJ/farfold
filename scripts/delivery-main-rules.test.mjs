import { describe, expect, it, vi } from "vitest";
import { verifyDeliveryMainRules } from "./delivery-main-rules.mjs";

const repository = "KPGH-FJ/farfold";
const publisher = 5913751;
const original = 27971261;
const rollout = 28068938;
const update = 28143311;
const engineering = "Farfold delivery check";
const final = "Farfold final delivery";

const entry = (ruleset, type, parameters) => ({
  ruleset_id: ruleset,
  ruleset_source: repository,
  ruleset_source_type: "Repository",
  type,
  parameters,
});

const required = (ruleset, context, app, extra = {}) =>
  entry(ruleset, "required_status_checks", {
    strict_required_status_checks_policy: true,
    do_not_enforce_on_create: false,
    required_status_checks: [{ context, integration_id: app }],
    ...extra,
  });

function rules() {
  return [
    entry(update, "update"),
    entry(original, "pull_request", {
      require_extra_approval_for_unattributed_changes: true,
      allowed_merge_methods: ["merge", "squash", "rebase"],
    }),
    required(original, engineering, 15368),
  ];
}

describe("active main delivery rules", () => {
  it.each([[rollout], [original], [rollout, original]])(
    "accepts a source-pinned strict final rule in phase %j",
    (...layers) => {
      const fixed = rules();
      for (const layer of layers) {
        if (layer === original) {
          fixed[2].parameters.required_status_checks.push({
            context: final,
            integration_id: publisher,
          });
        } else {
          fixed.push(required(layer, final, publisher));
        }
      }
      const api = vi.fn(() => fixed);
      expect(() =>
        verifyDeliveryMainRules(api, repository, publisher),
      ).not.toThrow();
      expect(api).toHaveBeenCalledExactlyOnceWith(
        "rules/branches/main?per_page=100",
      );
    },
  );

  it.each([
    ["wrong App", required(rollout, final, 15368)],
    ["any source", required(rollout, final, null)],
    [
      "non-strict",
      required(rollout, final, publisher, {
        strict_required_status_checks_policy: false,
      }),
    ],
    [
      "unenforced on create",
      required(rollout, final, publisher, {
        do_not_enforce_on_create: true,
      }),
    ],
    ["unknown ruleset", required(1, final, publisher)],
    [
      "another repository",
      {
        ...required(rollout, final, publisher),
        ruleset_source: "another/farfold",
      },
    ],
  ])("rejects final protection with %s", (_label, rule) => {
    expect(() =>
      verifyDeliveryMainRules(() => [...rules(), rule], repository, publisher),
    ).toThrow(/strict final delivery/);
  });

  it("rejects a first-installation check and conflicting final source", () => {
    const active = [...rules(), required(rollout, final, publisher)];
    const firstInstallation = required(
      rollout,
      "Farfold transition review",
      publisher,
    );
    expect(() =>
      verifyDeliveryMainRules(
        () => [...active, firstInstallation],
        repository,
        publisher,
      ),
    ).toThrow(/first-installation/);
    expect(() =>
      verifyDeliveryMainRules(
        () => [...active, required(1, final, 15368)],
        repository,
        publisher,
      ),
    ).toThrow(/strict final delivery/);
  });

  it.each([0, 1, 2])("rejects absence of original protection %s", (index) => {
    const active = rules();
    active.splice(index, 1);
    active.push(required(rollout, final, publisher));
    expect(() =>
      verifyDeliveryMainRules(() => active, repository, publisher),
    ).toThrow(/missing/);
  });

  it("propagates an unavailable effective-rules read", () => {
    const api = () => {
      throw new Error("GitHub rejected the request");
    };
    expect(() => verifyDeliveryMainRules(api, repository, publisher)).toThrow(
      /GitHub rejected the request/,
    );
  });
});

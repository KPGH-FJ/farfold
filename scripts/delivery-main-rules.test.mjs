import { describe, expect, it, vi } from "vitest";
import { verifyDeliveryMainRules } from "./delivery-main-rules.mjs";

const repository = "KPGH-FJ/farfold";
const publisher = 5913751;
const original = 27971261;
const rollout = 28068938;
const update = 28143311;
const ruleNodes = {
  [original]: "RRS_lACqUmVwb3NpdG9yec5QX1nqzgGqzr0",
  [rollout]: "RRS_lACqUmVwb3NpdG9yec5QX1nqzgGsTEo",
  [update]: "RRS_lACqUmVwb3NpdG9yec5QX1nqzgGtbs8",
};
const engineering = {
  context: "Farfold delivery check",
  integration_id: 15368,
};
const final = { context: "Farfold final delivery", integration_id: publisher };
const branchRoute = "rules/branches/main?per_page=100";

const checks = (...required) => ({
  type: "required_status_checks",
  parameters: {
    strict_required_status_checks_policy: true,
    do_not_enforce_on_create: false,
    required_status_checks: required,
  },
});

function fixture({ temporary = true, permanent = false } = {}) {
  const rules = new Map([
    [
      original,
      [
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge", "squash", "rebase"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_extra_approval_for_unattributed_changes: true,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: false,
            required_reviewers: [],
          },
        },
        permanent ? checks(final, engineering) : checks(engineering),
      ],
    ],
    ...(temporary ? [[rollout, [checks(final)]]] : []),
    [update, [{ type: "update" }]],
  ]);
  const metadata = new Map(
    [...rules].map(([id, entries]) => [
      id,
      {
        id,
        node_id: ruleNodes[id],
        target: "branch",
        enforcement: "active",
        source_type: "Repository",
        source: repository,
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: structuredClone(entries),
        updated_at: "2026-11-26T15:17:03.419+08:00",
        bypass_actors:
          id === update
            ? [
                {
                  actor_id: publisher,
                  actor_type: "Integration",
                  bypass_mode: "pull_request",
                },
              ]
            : [],
      },
    ]),
  );
  const active = [...rules].reverse().flatMap(([id, entries]) =>
    entries.map((entry) => ({
      ...structuredClone(entry),
      ruleset_id: id,
      ruleset_source: repository,
      ruleset_source_type: "Repository",
    })),
  );
  const api = vi.fn((route) =>
    route === branchRoute
      ? active
      : metadata.get(Number(route.slice("rulesets/".length))),
  );
  return {
    active,
    metadata,
    api,
    verify: (options) =>
      verifyDeliveryMainRules(api, repository, publisher, options),
  };
}

describe("active main delivery rules", () => {
  it.each([
    [{ temporary: true, permanent: false }, [original, rollout, update]],
    [{ temporary: false, permanent: true }, [original, update]],
    [{ temporary: true, permanent: true }, [original, rollout, update]],
  ])("accepts source-pinned strict final checks in phase %j", (phase, ids) => {
    const { api, verify } = fixture(phase);
    const projected = verify({ owner: true });
    expect(projected.map(({ id }) => id)).toEqual(ids);
    expect(projected.map(({ nodeId }) => nodeId)).toEqual(
      ids.map((id) => ruleNodes[id]),
    );
    expect(api.mock.calls.map(([route]) => route)).toEqual([
      branchRoute,
      ...ids.map((id) => `rulesets/${id}`),
    ]);
  });

  it.each([
    [
      "any source",
      (rule) => {
        rule.parameters.required_status_checks[0].integration_id = null;
      },
    ],
    [
      "wrong App",
      (rule) => {
        rule.parameters.required_status_checks[0].integration_id = 15368;
      },
    ],
    [
      "non-strict",
      (rule) => {
        rule.parameters.strict_required_status_checks_policy = false;
      },
    ],
    [
      "unenforced on create",
      (rule) => {
        rule.parameters.do_not_enforce_on_create = true;
      },
    ],
  ])("rejects final protection with %s", (_reason, weaken) => {
    const { active, verify } = fixture();
    weaken(active.find(({ ruleset_id }) => ruleset_id === rollout));
    expect(() => verify()).toThrow(/effective main policy differs/);
  });

  it.each([
    ["required_approving_review_count", 1],
    ["required_reviewers", [{ id: 42 }]],
    ["allowed_merge_methods", ["merge"]],
    ["require_extra_approval_for_unattributed_changes", false],
  ])("rejects drift in original PR rule field %s", (field, value) => {
    const { active, verify } = fixture();
    active.find(({ type }) => type === "pull_request").parameters[field] =
      value;
    expect(() => verify()).toThrow(/effective main policy differs/);
  });

  it.each([update, original])(
    "rejects absence of original ruleset %s",
    (id) => {
      const { active, verify } = fixture();
      for (let index = active.length - 1; index >= 0; index--) {
        if (active[index].ruleset_id === id) active.splice(index, 1);
      }
      expect(() => verify()).toThrow(/effective main policy differs/);
    },
  );

  it("rejects first-installation, unknown-source and conflicting active rules", () => {
    const { active, verify } = fixture();
    const daily = active.find(({ ruleset_id }) => ruleset_id === rollout);
    daily.parameters.required_status_checks[0] = {
      ...final,
      context: "Farfold transition review",
    };
    expect(() => verify()).toThrow(/first-installation/);
    daily.parameters.required_status_checks[0] = { ...final };
    active.push({
      ...daily,
      ruleset_id: 12,
      ruleset_source: "another/farfold",
    });
    expect(() => verify()).toThrow(/unexpected ruleset or source/i);
    active.pop();
    active.push({ ...daily, type: "deletion", parameters: null });
    expect(() => verify()).toThrow(/unexpected active main rule type/i);
  });

  it("checks effective rules, metadata and scope together", () => {
    const { metadata, verify } = fixture();
    const details = metadata.get(rollout);
    details.rules[0].parameters.required_status_checks[0].integration_id = 15368;
    expect(() => verify()).toThrow(/changed during readback/);
    details.rules[0].parameters.required_status_checks[0].integration_id =
      publisher;
    details.conditions.ref_name.include.push("refs/heads/*");
    expect(() => verify()).toThrow(/scope changed/);
  });

  it("normalizes omitted false create flags and rejects null", () => {
    const { active, metadata, verify } = fixture();
    const before = verify();
    const rule = active.find(({ ruleset_id }) => ruleset_id === rollout);
    delete rule.parameters.do_not_enforce_on_create;
    delete metadata.get(original).rules[1].parameters.do_not_enforce_on_create;
    expect(verify()).toEqual(before);
    rule.parameters.do_not_enforce_on_create = null;
    expect(() => verify()).toThrow(/effective main policy differs/);
  });

  it("requires the original GitHub rule node identity", () => {
    const { metadata, verify } = fixture();
    metadata.get(rollout).node_id = ruleNodes[original];
    expect(() => verify()).toThrow(/changed identity or activation/);
    delete metadata.get(rollout).node_id;
    expect(() => verify()).toThrow(/changed identity or activation/);
  });

  it("makes owner and reader projections identical with time zone and ordering differences", () => {
    const { metadata, verify } = fixture({ temporary: true, permanent: true });
    const owner = verify({ owner: true });
    expect(owner[0].updatedAt).toBe("2026-11-26T07:17:03.419Z");
    for (const details of metadata.values()) {
      delete details.bypass_actors;
      details.rules.reverse();
      details.updated_at = "2026-11-26T07:17:03.419Z";
    }
    expect(verify()).toEqual(owner);
    expect(() => verify({ owner: true })).toThrow(
      /bypass actors differ or are hidden/,
    );
    metadata.get(update).updated_at = "2026-11-26T07:17:03.420Z";
    expect(verify()).not.toEqual(owner);
  });

  it("requires update-only App bypass and empty bypass on checks", () => {
    const { metadata, verify } = fixture();
    const updateActors = metadata.get(update).bypass_actors;
    metadata.get(original).bypass_actors = updateActors;
    expect(() => verify({ owner: true })).toThrow(/bypass actors differ/);
    metadata.get(original).bypass_actors = [];
    updateActors[0].bypass_mode = "always";
    expect(() => verify({ owner: true })).toThrow(/bypass actors differ/);
  });

  it("requires a precise ruleset revision and propagates API failure", () => {
    const { metadata, verify } = fixture();
    delete metadata.get(update).updated_at;
    expect(() => verify()).toThrow(/lacks its revision timestamp/);
    const api = () => {
      throw new Error("GitHub rejected the request");
    };
    expect(() => verifyDeliveryMainRules(api, repository, publisher)).toThrow(
      /GitHub rejected the request/,
    );
  });
});

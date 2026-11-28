import assert from "node:assert/strict";

const deliveryRuleset = 27971261;
const rolloutRuleset = 28068938;
const appUpdateRuleset = 28143311;
const ruleNodes = new Map([
  [deliveryRuleset, "RRS_lACqUmVwb3NpdG9yec5QX1nqzgGqzr0"],
  [rolloutRuleset, "RRS_lACqUmVwb3NpdG9yec5QX1nqzgGsTEo"],
  [appUpdateRuleset, "RRS_lACqUmVwb3NpdG9yec5QX1nqzgGtbs8"],
]);
const mainBranch = { ref_name: { include: ["refs/heads/main"], exclude: [] } };
const engineeringCheck = "Farfold delivery check";
const finalCheck = "Farfold final delivery";
const transitionCheck = "Farfold transition review";
const actionsAppId = 15368;
const pullRequest = {
  type: "pull_request",
  parameters: {
    allowed_merge_methods: ["merge", "rebase", "squash"],
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_extra_approval_for_unattributed_changes: true,
    require_last_push_approval: false,
    required_approving_review_count: 0,
    required_review_thread_resolution: false,
    required_reviewers: [],
  },
};

function checkRule(requiredStatusChecks) {
  return {
    type: "required_status_checks",
    parameters: {
      do_not_enforce_on_create: false,
      required_status_checks: requiredStatusChecks,
      strict_required_status_checks_policy: true,
    },
  };
}

function visibleRules(rules) {
  assert.ok(Array.isArray(rules), "Main rule details are missing.");
  return rules
    .map(({ type, parameters }) => {
      if (type === "update") {
        assert.equal(parameters ?? null, null, "Unexpected update parameters.");
        return { type };
      }
      if (type === "pull_request") {
        assert.ok(
          Array.isArray(parameters?.allowed_merge_methods),
          "Main pull request options are missing.",
        );
        return {
          type,
          parameters: {
            ...parameters,
            allowed_merge_methods: [...parameters.allowed_merge_methods].sort(),
          },
        };
      }
      assert.equal(
        type,
        "required_status_checks",
        "Unexpected active main rule type.",
      );
      assert.ok(
        Array.isArray(parameters?.required_status_checks),
        "Main status check options are missing.",
      );
      return {
        type,
        parameters: {
          ...parameters,
          do_not_enforce_on_create:
            parameters.do_not_enforce_on_create === undefined
              ? false
              : parameters.do_not_enforce_on_create,
          required_status_checks: [...parameters.required_status_checks].sort(
            (a, b) => a.context.localeCompare(b.context, "en"),
          ),
        },
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type, "en"));
}

function ruleRevision(updatedAt) {
  assert.match(
    updatedAt ?? "",
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/,
    "The active main ruleset lacks its revision timestamp.",
  );
  return new Date(updatedAt).toISOString();
}

export function verifyDeliveryMainRules(
  api,
  repo,
  publisherAppId,
  { owner = false } = {},
) {
  assert.equal(
    repo,
    "KPGH-FJ/farfold",
    "Unexpected delivery rules repository.",
  );
  assert.ok(
    Number.isSafeInteger(publisherAppId) &&
      publisherAppId > 0 &&
      publisherAppId !== actionsAppId,
    "Expected a dedicated final delivery App.",
  );
  const active = api("rules/branches/main?per_page=100");
  assert.ok(
    Array.isArray(active) && active.length < 100,
    "The active main rules response is incomplete.",
  );
  assert.ok(
    active.every(
      (rule) =>
        ruleNodes.has(rule.ruleset_id) &&
        rule.ruleset_source_type === "Repository" &&
        rule.ruleset_source === repo,
    ),
    "Unexpected ruleset or source in the active main rules.",
  );
  const from = (id) => active.filter((rule) => rule.ruleset_id === id);
  const statusChecks = (rule) => rule.parameters?.required_status_checks ?? [];
  assert.ok(
    !active.some((rule) =>
      statusChecks(rule).some(({ context }) => context === transitionCheck),
    ),
    "The first-installation check is still active. Daily merge is unavailable.",
  );
  const original = from(deliveryRuleset);
  const rolloutActive = from(rolloutRuleset).length > 0;
  const permanentFinal = original.some((rule) =>
    statusChecks(rule).some(({ context }) => context === finalCheck),
  );
  assert.ok(
    rolloutActive || permanentFinal,
    "The strict final delivery check is missing.",
  );
  const engineering = {
    context: engineeringCheck,
    integration_id: actionsAppId,
  };
  const final = { context: finalCheck, integration_id: publisherAppId };
  const expected = [
    [
      deliveryRuleset,
      [
        pullRequest,
        checkRule(permanentFinal ? [engineering, final] : [engineering]),
      ],
      [],
    ],
    ...(rolloutActive ? [[rolloutRuleset, [checkRule([final])], []]] : []),
    [
      appUpdateRuleset,
      [{ type: "update" }],
      [
        {
          actor_id: publisherAppId,
          actor_type: "Integration",
          bypass_mode: "pull_request",
        },
      ],
    ],
  ];
  return expected.map(([id, rules, bypass]) => {
    assert.deepEqual(
      visibleRules(from(id)),
      rules,
      `The effective main policy differs for ruleset ${id}.`,
    );
    const details = api(`rulesets/${id}`);
    assert.ok(
      details?.id === id &&
        details.node_id === ruleNodes.get(id) &&
        details.target === "branch" &&
        details.enforcement === "active" &&
        details.source_type === "Repository" &&
        details.source === repo,
      `The active branch ruleset ${id} changed identity or activation.`,
    );
    assert.deepEqual(
      details.conditions,
      mainBranch,
      `The scope changed for main ruleset ${id}.`,
    );
    assert.deepEqual(
      visibleRules(details.rules),
      rules,
      `The main ruleset ${id} changed during readback.`,
    );
    if (owner || Object.hasOwn(details, "bypass_actors")) {
      assert.deepEqual(
        details.bypass_actors,
        bypass,
        `The bypass actors differ or are hidden for main ruleset ${id}.`,
      );
    }
    // Metadata readers can compare the revision captured in an owner-verified
    // dispatch, but only a ruleset writer can see the actual bypass actors.
    return {
      id,
      nodeId: details.node_id,
      updatedAt: ruleRevision(details.updated_at),
      rules: structuredClone(rules),
    };
  });
}

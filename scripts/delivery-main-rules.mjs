import assert from "node:assert/strict";

const deliveryRuleset = 27971261;
const rolloutRuleset = 28068938;
const appUpdateRuleset = 28143311;
const engineeringCheck = "Farfold delivery check";
const finalCheck = "Farfold final delivery";
const transitionCheck = "Farfold transition review";
const actionsAppId = 15368;

export function verifyDeliveryMainRules(api, repo, publisherAppId) {
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
  const rules = api("rules/branches/main?per_page=100");
  assert.ok(
    Array.isArray(rules) && rules.length < 100,
    "The active main rules response is incomplete.",
  );
  const from = (id) =>
    rules.filter(
      (rule) =>
        rule.ruleset_id === id &&
        rule.ruleset_source_type === "Repository" &&
        rule.ruleset_source === repo,
    );
  const original = from(deliveryRuleset);
  const update = from(appUpdateRuleset);
  assert.deepEqual(
    update.map(({ type }) => type),
    ["update"],
    "The active App update restriction is missing or changed.",
  );
  assert.ok(
    original.some(
      (rule) =>
        rule.type === "pull_request" &&
        rule.parameters?.require_extra_approval_for_unattributed_changes ===
          true &&
        rule.parameters.allowed_merge_methods?.includes("merge"),
    ),
    "The active original pull request rule is missing or changed.",
  );

  const requiredChecks = (rule) =>
    rule.type === "required_status_checks"
      ? (rule.parameters?.required_status_checks ?? [])
      : [];
  const strictCheck = (rule, context, appId) =>
    rule.parameters?.strict_required_status_checks_policy === true &&
    rule.parameters.do_not_enforce_on_create !== true &&
    requiredChecks(rule).some(
      (check) => check.context === context && check.integration_id === appId,
    );
  assert.ok(
    original.some((rule) => strictCheck(rule, engineeringCheck, actionsAppId)),
    "The original strict engineering check is missing or uses the wrong App.",
  );
  const allChecks = rules.flatMap(requiredChecks);
  assert.ok(
    !allChecks.some(({ context }) => context === transitionCheck),
    "The first-installation check is still active. Daily merge is unavailable.",
  );
  const final = [...original, ...from(rolloutRuleset)];
  assert.ok(
    final.some((rule) => strictCheck(rule, finalCheck, publisherAppId)) &&
      allChecks
        .filter(({ context }) => context === finalCheck)
        .every(({ integration_id }) => integration_id === publisherAppId),
    "The strict final delivery check is missing or uses the wrong App.",
  );
  // GitHub's effective-rules view establishes rule shape and source. It does
  // not expose bypass actors to the workflow's metadata-read credentials.
}

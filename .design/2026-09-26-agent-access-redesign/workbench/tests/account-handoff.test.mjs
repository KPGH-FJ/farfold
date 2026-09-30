import assert from "node:assert/strict";
import test from "node:test";
import {
  continueRegistrationLogin,
  registrationLoginIssue,
  registrationMatchesService,
} from "../src/account-handoff.js";
import { normalizeAgent } from "../src/agent-setup-state.js";
const methodA = {
  id: "a",
  type: "agent",
  presentation: "browser",
  label: "账号 A",
};
const methodB = {
  id: "b",
  type: "agent",
  presentation: "browser",
  label: "账号 B",
};
const selection = {
  access: "existing",
  folder: "/work",
  model: "chosen",
  effort: "High",
};
const agent = normalizeAgent({
  id: "example",
  name: "Example",
  installed: true,
  registered: true,
  connected: true,
  authMethods: [methodA, methodB],
  setupDraft: selection,
});
const registration = {
  kind: "account",
  methodId: "b",
  status: "registered",
  open: true,
  selection,
};
test("registration continues with its own declared method, preserving source/model/folder without claiming login", () => {
  const next = continueRegistrationLogin(agent, registration);
  assert.equal(next.accessJob.authMethod.id, "b");
  assert.equal(next.authMethodSelection, "b");
  assert.deepEqual(next.accessJob.selection, selection);
  assert.equal(next.registration.open, false);
  assert.equal(next.registration.loginJobId, next.accessJob.id);
  assert.equal(next.authentication, undefined);
  assert.equal(next.accessJob.status, "waiting");
});
test("registration continuation cannot start a duplicate job, interrupt active work, or fall back to another account", () => {
  for (const [current, options] of [
    [{ ...agent, authMethods: [methodA] }, {}],
    [
      {
        ...agent,
        accessJob: { id: "pending", type: "auth", status: "unknown" },
      },
      {},
    ],
    [agent, { busyCount: 1 }],
    [{ ...agent, connected: false }, {}],
    [agent, { selection: { ...selection, folder: "/another" } }],
  ]) {
    assert.ok(registrationLoginIssue(current, registration, options));
    assert.equal(
      continueRegistrationLogin(current, registration, options),
      current,
    );
  }
});
test("API registration identity follows provider/address/format, not mutable display name", () => {
  const draft = {
    provider: "A",
    name: "Display",
    endpoint: "https://a.example",
    format: "responses",
  };
  const state = { kind: "api", accountLabel: "A", selection: { ...draft } };
  assert.ok(registrationMatchesService(state, { ...draft, name: "Renamed" }));
  for (const change of [
    { provider: "B" },
    { endpoint: "https://b.example" },
    { format: "messages" },
  ])
    assert.equal(
      registrationMatchesService(state, { ...draft, ...change }),
      false,
    );
});

test("returning to registration recognizes only the matching login method and location", async () => {
  const { registrationLoginFinished } =
    await import("../src/account-handoff.js");
  const finished = {
    ...agent,
    authentication: {
      jobId: "job-current",
      status: "flow-finished",
      method: "b",
      folder: "/work",
    },
  };
  assert.ok(
    registrationLoginFinished(finished, {
      ...registration,
      loginJobId: "job-current",
    }),
  );
  assert.equal(registrationLoginFinished(finished, registration), false);
  assert.equal(
    registrationLoginFinished(finished, { ...registration, status: "ready" }),
    false,
  );
  assert.equal(
    registrationLoginFinished(finished, {
      ...registration,
      loginJobId: "job-older",
    }),
    false,
  );
  assert.equal(
    registrationLoginFinished(finished, {
      ...registration,
      loginJobId: "job-current",
      methodId: "a",
    }),
    false,
  );
  assert.equal(
    registrationLoginFinished(finished, {
      ...registration,
      loginJobId: "job-current",
      selection: { ...selection, folder: "/other" },
    }),
    false,
  );
});

test("the actual login receipt completes only the registration that started it", async () => {
  const { registrationLoginFinished } =
    await import("../src/account-handoff.js");
  const { continueAgentJob, advanceAgentJobs } =
    await import("../src/access-jobs.js");
  const started = continueRegistrationLogin(agent, {
    ...registration,
    status: "ready",
  });
  const running = continueAgentJob(started, started.accessJob.id, 100);
  const [reconnecting] = advanceAgentJobs([running], 10000);
  const [finished] = advanceAgentJobs([reconnecting], 20000);
  assert.equal(finished.accessJob, null);
  assert.ok(registrationLoginFinished(finished, started.registration));
  assert.equal(
    registrationLoginFinished(finished, { ...registration, status: "ready" }),
    false,
  );
});

test("explicitly adopting the current preparation preserves registration facts without borrowing an old login", async () => {
  const { rebaseRegistrationSelection, registrationLoginFinished } =
    await import("../src/account-handoff.js");
  assert.equal(typeof rebaseRegistrationSelection, "function");
  const old = {
    ...registration,
    loginJobId: "old-login",
    destination: { label: "Account B", verified: false },
  };
  const current = {
    ...agent,
    registration: old,
    authentication: {
      jobId: "old-login",
      method: "b",
      status: "flow-finished",
      folder: "/work",
    },
  };
  const nextSelection = {
    ...selection,
    folder: "/another",
    model: "new-choice",
  };
  assert.match(
    registrationLoginIssue(current, old, { selection: nextSelection }),
    /选择已改变/,
  );
  const next = rebaseRegistrationSelection(current, old, {
    selection: nextSelection,
  });
  assert.deepEqual(next.registration.selection, nextSelection);
  assert.notEqual(next.registration.selection, nextSelection);
  assert.equal(next.registration.status, "registered");
  assert.deepEqual(next.registration.destination, old.destination);
  assert.equal(next.registration.methodId, "b");
  assert.equal(Object.hasOwn(next.registration, "loginJobId"), false);
  assert.equal(registrationLoginFinished(next, next.registration), false);
  assert.equal(next.accessJob, undefined);
  assert.equal(next.authentication, current.authentication);
  assert.equal(
    registrationLoginIssue(next, next.registration, {
      selection: nextSelection,
    }),
    null,
  );
  const started = continueRegistrationLogin(next, next.registration, {
    selection: nextSelection,
  });
  assert.deepEqual(started.accessJob.selection, nextSelection);
});

test("registration selection cannot be silently rebased when busy, unavailable, or missing a current choice", async () => {
  const { rebaseRegistrationSelection } =
    await import("../src/account-handoff.js");
  assert.equal(typeof rebaseRegistrationSelection, "function");
  for (const [current, record, options] of [
    [agent, registration, { selection, busyCount: 1 }],
    [
      {
        ...agent,
        accessJob: { id: "pending", type: "auth", status: "unknown" },
      },
      registration,
      { selection },
    ],
    [{ ...agent, authMethods: [methodA] }, registration, { selection }],
    [{ ...agent, connected: false }, registration, { selection }],
    [agent, { ...registration, kind: "api" }, { selection }],
    [agent, registration, {}],
  ])
    assert.equal(
      rebaseRegistrationSelection(current, record, options),
      current,
    );
});

test("same service ID with a different source or configuration cannot resume an old registration login", async () => {
  const original = {
    ...selection,
    access: "api",
    serviceId: "s",
    serviceSnapshot: {
      id: "s",
      name: "Old label",
      endpoint: "https://old.example/v1",
      format: "responses",
      revision: 1,
      secretRevision: 2,
    },
  };
  const saved = { ...registration, selection: original };
  for (const change of [
    { endpoint: "https://new.example/v1" },
    { format: "chat-completions" },
    { revision: 2 },
    { secretRevision: 3 },
  ]) {
    const current = {
      ...original,
      serviceSnapshot: { ...original.serviceSnapshot, ...change },
    };
    assert.match(
      registrationLoginIssue(agent, saved, { selection: current }),
      /选择已改变/,
    );
    assert.equal(
      continueRegistrationLogin(agent, saved, { selection: current }),
      agent,
    );
    const { rebaseRegistrationSelection } =
      await import("../src/account-handoff.js");
    const rebased = rebaseRegistrationSelection(agent, saved, {
      selection: current,
    });
    const started = continueRegistrationLogin(rebased, rebased.registration, {
      selection: current,
    });
    assert.deepEqual(
      started.accessJob.selection.serviceSnapshot,
      current.serviceSnapshot,
    );
  }
});

test("renaming a service keeps the registration identity and does not require adopting another source", () => {
  const original = {
    ...selection,
    access: "api",
    serviceId: "s",
    serviceSnapshot: {
      id: "s",
      name: "Old label",
      endpoint: "https://a.example/v1",
      format: "responses",
      revision: 1,
      secretRevision: 2,
    },
  };
  const current = {
    ...original,
    serviceSnapshot: { ...original.serviceSnapshot, name: "Renamed" },
  };
  assert.equal(
    registrationLoginIssue(
      agent,
      { ...registration, selection: original },
      { selection: current },
    ),
    null,
  );
});

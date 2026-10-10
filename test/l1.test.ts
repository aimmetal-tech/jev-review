import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { classifyL1, createReadScope, type L1Context } from "../src/l1.ts";
import { QUESTIONS, readConfig, review, type ReviewState } from "../src/reviewer.ts";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "layer-fixture-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "docs"));
  await writeFile(join(cwd, "docs", "note.md"), "hello\n");
  await writeFile(join(cwd, "outside.md"), "outside\n");
  const scope = await createReadScope(cwd, "docs");
  assert.ok(scope);
  const local: L1Context = { host: "pi", provenance: { source: "builtin", path: "builtin:read" }, scope, isValid: () => true };
  const state: ReviewState = {
    operation: { source: "agent", tool: "read", cwd, input: { path: "docs/note.md", offset: 1, limit: 20 } },
    userRequests: ["Read the authorized docs"], incompleteContext: false,
  };
  return { cwd, local, state };
}

function apiResponse(authorization = "authorized", risk = "routine") {
  const choice = (value: string, keys: string[]) => ({ type: "choice", choice: value, confidence: 1,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(key === value)])) });
  return Response.json({ model: "jev-1.13.0", answers: {
    authorization: choice(authorization, Object.keys(QUESTIONS.authorization.criteria)),
    risk: choice(risk, Object.keys(QUESTIONS.risk.criteria)),
  } });
}

test("scoped built-in read is local only in enforce; observe and off retain Jev", async t => {
  const { state, local } = await fixture(t);
  for (const l1Mode of ["observe", "enforce", "off"] as const) {
    let requests = 0, notifications = 0;
    const verdict = await review(state, readConfig({ TYPESAFE_API_KEY: "test-key", JEV_L1_MODE: l1Mode }),
      async (_url, init) => {
        requests++;
        assert.deepEqual(JSON.parse(init!.body as string).state, state);
        assert.equal((init!.body as string).includes("provenance"), false);
        return apiResponse();
      }, undefined, { l1: local, onJevRequest: () => { notifications++; } });
    assert.equal(verdict.decision, "allow");
    assert.equal(requests, l1Mode === "enforce" ? 0 : 1);
    assert.equal(notifications, requests);
    assert.equal(verdict.source, l1Mode === "enforce" ? "l1" : "jev");
    assert.equal(Boolean(verdict.l1Candidate), l1Mode !== "off");
    if (verdict.source === "l1") {
      assert.equal(verdict.authorization, undefined);
      assert.equal(verdict.risk, undefined);
      assert.equal(verdict.usage, undefined);
    }
  }
});

test("observe preserves Jev denial and human review rather than using the candidate", async t => {
  const { state, local } = await fixture(t);
  for (const [authorization, risk, expected] of [["unapproved", "routine", "deny"], ["authorized", "sensitive", "review"]]) {
    const verdict = await review(state, readConfig({ TYPESAFE_API_KEY: "test-key" }),
      async () => apiResponse(authorization, risk), undefined, { l1: local });
    assert.equal(verdict.decision, expected);
    assert.equal(verdict.source, "jev");
    assert.equal(verdict.l1Candidate, "l1.pi-builtin-read");
  }
});

test("manual, missing key, protected path, incomplete or oversized context and cancellation precede L1", async t => {
  const { state, local } = await fixture(t);
  const config = readConfig({ TYPESAFE_API_KEY: "test-key", JEV_L1_MODE: "enforce" });
  const cancelled = AbortSignal.abort();
  const never: typeof fetch = async () => { assert.fail("Unexpected Jev request"); };
  const cases: [ReviewState, typeof config, AbortSignal | undefined][] = [
    [state, { ...config, mode: "manual" as const }, undefined],
    [state, { ...config, apiKey: undefined }, undefined],
    [{ ...state, operation: { ...state.operation, input: { path: "docs/.env" } } }, config, undefined],
    [{ ...state, incompleteContext: true }, config, undefined],
    [{ ...state, userRequests: ["x".repeat(40000)] }, config, undefined],
    [state, config, cancelled],
  ];
  for (const [input, settings, signal] of cases) {
    const verdict = await review(input, settings, never, signal, { l1: local });
    assert.equal(verdict.decision, "review");
    assert.equal(verdict.source, "local");
    assert.equal(verdict.l1Candidate, undefined);
  }
  const cyclic: Record<string, unknown> = { path: "docs/note.md" }; cyclic.loop = cyclic;
  assert.equal((await review({ ...state, operation: { ...state.operation, input: cyclic } }, config, never, undefined, { l1: local })).source, "local");
});

test("shadow never bypasses Jev even when L1 is enforce", async t => {
  const { state, local } = await fixture(t);
  const verdict = await review(state, readConfig({ TYPESAFE_API_KEY: "test-key", JEV_L1_MODE: "enforce", JEV_MODE: "shadow" }),
    async () => apiResponse("unapproved"), undefined, { l1: local });
  assert.equal(verdict.source, "jev");
  assert.equal(verdict.decision, "deny");
});

test("missing grants, custom origins, write/edit/bash and forged input capability all escalate", async t => {
  const { state, local } = await fixture(t);
  assert.equal((await classifyL1(state.operation)).decision, "defer");
  assert.equal((await classifyL1(state.operation, { ...local, isValid: () => false })).decision, "defer");
  for (const provenance of [{ source: "extension", path: "custom:read" }, { source: "builtin", path: "builtin:write" }]) {
    assert.equal((await classifyL1(state.operation, { ...local, provenance })).decision, "defer");
  }
  for (const tool of ["write", "edit", "bash", "read_file", "grep", "ls", "find"]) {
    assert.equal((await classifyL1({ ...state.operation, tool }, local)).decision, "defer");
  }
  assert.equal((await classifyL1({ ...state.operation, input: { path: "docs/note.md", trustedRead: true } }, local)).decision, "defer");
  const verdict = await review(state, readConfig({ TYPESAFE_API_KEY: "test-key", JEV_L1_MODE: "enforce" }), async () => apiResponse("unapproved"));
  assert.equal(verdict.source, "jev");
  assert.equal(verdict.decision, "deny");
});

test("unsupported paths, bounds, fields, directories and missing files cannot pass L1", async t => {
  const { cwd, state, local } = await fixture(t);
  for (const path of ["../escape.md", "outside.md", "docs", "docs/missing.md", "@docs/note.md", "~/docs/note.md",
    "file:///docs/note.md", "C:docs/note.md", "docs/note.md:stream", "docs/\u00a0note.md", "docs/note.md\0", "docs/.env"]) {
    assert.equal((await classifyL1({ ...state.operation, input: { path } }, local)).decision, "defer", path);
  }
  for (const input of [{ path: "docs/note.md", offset: 0 }, { path: "docs/note.md", limit: -1 },
    { path: "docs/note.md", offset: 1.2 }, { path: "docs/note.md", limit: Infinity },
    { path: "docs/note.md", limit: "20" }, { path: "docs/note.md", extra: true }]) {
    assert.equal((await classifyL1({ ...state.operation, input }, local)).decision, "defer");
  }
  assert.equal((await classifyL1({ ...state.operation, input: { path: join(cwd, "docs/note.md") } }, local)).decision, "allow");
  for (const directory of [".", "outside.md", "../", "@docs", "file:///docs", "missing"]) assert.equal(await createReadScope(cwd, directory), undefined);
});

test("directory links and linked ancestors cannot establish a grant or pass reads", async t => {
  const { cwd, local, state } = await fixture(t);
  // Windows directory junctions require no developer-mode symlink privilege.
  await symlink(join(cwd, "docs"), join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await createReadScope(cwd, "alias"), undefined);
  assert.equal(await createReadScope(join(cwd, "alias"), "child"), undefined);
  assert.equal((await classifyL1({ ...state.operation, input: { path: "alias/note.md" } }, local)).decision, "defer");
  await symlink(join(cwd, "docs"), join(cwd, "docs", "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await classifyL1({ ...state.operation, input: { path: "docs/linked/note.md" } }, local)).decision, "defer");
  if (process.platform !== "win32") {
    await symlink(join(cwd, "docs", "note.md"), join(cwd, "docs", "file-link.md"));
    assert.equal((await classifyL1({ ...state.operation, input: { path: "docs/file-link.md" } }, local)).decision, "defer");
  }
});

test("grant revalidation and failed observations never become local approval", async t => {
  const { state, local } = await fixture(t);
  let checks = 0;
  assert.equal((await classifyL1(state.operation, { ...local, isValid: () => ++checks === 1 })).decision, "defer");
  assert.equal((await classifyL1(state.operation, { ...local, isValid: () => { throw new Error("stale context"); } })).decision, "defer");
  let requests = 0;
  const verdict = await review(state, readConfig({ TYPESAFE_API_KEY: "test-key" }), async () => { throw new Error("provider secret"); },
    undefined, { l1: local, onJevRequest: () => { requests++; } });
  assert.equal(verdict.source, "local");
  assert.equal(verdict.decision, "review");
  assert.equal(verdict.l1Candidate, "l1.pi-builtin-read");
  assert.equal(requests, 1);
  assert.equal(verdict.reason.includes("secret"), false);
});

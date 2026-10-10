import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jevReview from "../src/adapters/pi.ts";
import { QUESTIONS } from "../src/reviewer.ts";

function apiResponse(authorization = "authorized", risk = "routine") {
  function answer(choice: string, criteria: object) {
    return { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, Number(k === choice)])) };
  }
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {
    authorization: answer(authorization, QUESTIONS.authorization.criteria), risk: answer(risk, QUESTIONS.risk.criteria),
  }, usage: { input_tokens: 500, output_tokens: 30 } }));
}
function harness(t: TestContext, env: Record<string, string> = {}, hasUI = false) {
  const names = new Set([...Object.keys(process.env).filter(k => k.startsWith("JEV_")), "TYPESAFE_API_KEY", ...Object.keys(env)]);
  const saved = Object.fromEntries([...names].map(k => [k, process.env[k]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { TYPESAFE_API_KEY: "test-key", ...env });
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const sent: string[] = [];
  const entries: any[] = [{ id: "original-user", type: "message", message: { role: "user", content: "Inspect project files" } }];
  const tools: { name: string; description: string; sourceInfo?: { source: string; path: string } }[] = [
    { name: "bash", description: "Execute shell commands" },
    { name: "read", description: "Read a file", sourceInfo: { source: "builtin", path: "builtin:read" } },
  ];
  const ctx = {
    cwd: "/project", hasUI, signal: undefined as AbortSignal | undefined,
    isIdle: () => true, hasPendingMessages: () => false,
    ui: { setStatus() {}, notify(message: string) { notifications.push(message); }, async confirm(_title: string, _message: string, _options?: unknown) { return false; } },
    sessionManager: { getBranch: () => entries, getSessionId: () => "test-session" },
  };
  const api = { on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand(name: string, command: any) { commands.set(name, command); },
    getAllTools: () => tools, sendUserMessage: (text: string) => { sent.push(text); } };
  jevReview(api as unknown as ExtensionAPI);
  const call = (tool = "bash", input: Record<string, unknown> = { command: "git status" }) => handlers.get("tool_call")!({ toolName: tool, input }, ctx);
  return { ctx, handlers, commands, notifications, call, sent, entries, tools, api };
}

async function scopedHarness(t: TestContext, env: Record<string, string> = {}) {
  const h = harness(t, { JEV_L1_MODE: "enforce", ...env }, true);
  const cwd = await mkdtemp(join(tmpdir(), "pi-layer-fixture-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "docs"));
  await writeFile(join(cwd, "docs", "note.md"), "hello\n");
  h.ctx.cwd = cwd;
  t.mock.method(h.ctx.ui, "confirm", async (title: string) => title.includes("scoped read task"));
  return h;
}

async function dispatchReadTask(h: ReturnType<typeof harness>, task = "Read note.md") {
  await h.commands.get("jev").handler(`read-task docs -- ${task}`, h.ctx);
  const text = h.sent.at(-1)!;
  assert.ok(text);
  await h.handlers.get("input")!({ text, source: "extension" }, h.ctx);
  await h.handlers.get("before_agent_start")!({ prompt: text }, h.ctx);
  h.entries.push({ id: `task-${h.sent.length}`, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  return text;
}

async function layerStatus(h: ReturnType<typeof harness>) {
  await h.commands.get("jev").handler("status", h.ctx);
  return JSON.parse(h.notifications.at(-1)!);
}

test("Pi tool_call permits an approved routine command", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => apiResponse());
  assert.equal(await h.call(), undefined);
});
test("write, edit and custom tools all pass through Jev", async t => {
  const h = harness(t);
  const tools: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { tools.push(JSON.parse(init.body as string).state.operation.tool); return apiResponse("unapproved"); });
  for (const tool of ["write", "edit", "mcp_send_message"]) assert.equal((await h.call(tool, { content: "data" })).block, true);
  assert.deepEqual(tools, ["write", "edit", "mcp_send_message"]);
});
test("headless execution blocks uncertain, sensitive, destructive and failed reviews", async t => {
  const h = harness(t);
  for (const risk of ["sensitive", "destructive", "unknown"]) {
    t.mock.method(globalThis, "fetch", async () => apiResponse("authorized", risk));
    assert.equal((await h.call()).block, true);
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret"); });
  const result = await h.call();
  assert.equal(result.block, true);
  assert.equal(result.reason.includes("secret"), false);
});
test("UI approval is scoped to one operation and denial blocks it", async t => {
  const h = harness(t, {}, true);
  t.mock.method(globalThis, "fetch", async () => apiResponse("authorized", "sensitive"));
  let approvals = 0;
  t.mock.method(h.ctx.ui, "confirm", async (_title: string, message: string) => { approvals++; assert.match(message, /git status/); return approvals === 1; });
  assert.equal(await h.call(), undefined);
  assert.equal((await h.call()).block, true);
  assert.equal(approvals, 2);
});
test("closed or failed approval dialogs block the operation", async t => {
  const h = harness(t, { JEV_MODE: "manual" }, true);
  t.mock.method(h.ctx.ui, "confirm", async () => { throw new Error("closed"); });
  assert.equal((await h.call()).block, true);
});
test("concurrent tool calls serialize approval dialogs", async t => {
  const h = harness(t, { JEV_MODE: "manual" }, true);
  let active = 0, peak = 0;
  t.mock.method(h.ctx.ui, "confirm", async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return true; });
  assert.deepEqual(await Promise.all([h.call(), h.call(), h.call()]), [undefined, undefined, undefined]);
  assert.equal(peak, 1);
});
test("payload changes during review block execution", async t => {
  const h = harness(t);
  const input = { command: "git status" };
  t.mock.method(globalThis, "fetch", async () => { input.command = "rm -rf /"; return apiResponse(); });
  assert.match((await h.call("bash", input)).reason, /changed/);
});
test("payload changes during human confirmation block execution", async t => {
  const h = harness(t, { JEV_MODE: "manual" }, true);
  const input = { command: "git status" };
  t.mock.method(h.ctx.ui, "confirm", async () => { input.command = "rm -rf /"; return true; });
  assert.match((await h.call("bash", input)).reason, /changed/);
});
test("cancellation cannot become human approval", async t => {
  const h = harness(t, { JEV_MODE: "manual" }, true);
  const controller = new AbortController(); h.ctx.signal = controller.signal;
  t.mock.method(h.ctx.ui, "confirm", async () => { controller.abort(); return true; });
  assert.equal((await h.call()).block, true);
});
test("invalid config keeps the gate installed and blocks operations", async t => {
  const h = harness(t, { JEV_MODE: "typo" }, true);
  assert.match((await h.call()).reason, /Invalid/);
});
test("shadow mode observes without enforcing and reports token usage", async t => {
  const h = harness(t, { JEV_MODE: "shadow" });
  t.mock.method(globalThis, "fetch", async () => apiResponse("unapproved"));
  assert.equal(await h.call(), undefined);
  assert.match(h.notifications[0], /shadow: deny/);
  await h.commands.get("jev").handler("status", h.ctx);
  const status = JSON.parse(h.notifications.at(-1)!);
  assert.equal(status.stats.deny, 1);
  assert.equal(status.stats.inputTokens, 500);
  assert.equal(status.configured, true);
  assert.equal(h.notifications.at(-1)!.includes("test-key"), false);
});
test("shadow can only be enabled interactively with explicit confirmation", async t => {
  const h = harness(t, {}, true);
  await h.commands.get("jev").handler("mode shadow", h.ctx);
  await h.commands.get("jev").handler("status", h.ctx);
  assert.equal(JSON.parse(h.notifications.at(-1)!).mode, "auto");
  t.mock.method(h.ctx.ui, "confirm", async () => true);
  await h.commands.get("jev").handler("mode shadow", h.ctx);
  await h.commands.get("jev").handler("status", h.ctx);
  assert.equal(JSON.parse(h.notifications.at(-1)!).mode, "shadow");
});
test("direct user shell commands bypass review by default", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => { assert.fail("Unexpected API call"); });
  assert.equal(await h.handlers.get("user_bash")!({ command: "git status", cwd: "/project" }, h.ctx), undefined);
});
test("opt-in user shell review returns a blocked BashResult", async t => {
  const h = harness(t, { JEV_REVIEW_USER_BASH: "true" });
  t.mock.method(globalThis, "fetch", async () => apiResponse("authorized", "destructive"));
  const result = await h.handlers.get("user_bash")!({ command: "rm -rf data", cwd: "/project" }, h.ctx);
  assert.equal(result.result.exitCode, 1);
  assert.match(result.result.output, /Interactive approval/);
});

test("UI-confirmed read tasks skip Jev only in auto/enforce and expose separate counters", async t => {
  for (const l1Mode of ["enforce", "observe", "off"]) await t.test(l1Mode, async child => {
    const h = await scopedHarness(child, { JEV_L1_MODE: l1Mode });
    const text = await dispatchReadTask(h, "Read this private-task-text");
    assert.match(text, /Jev task ID: [0-9a-f-]{36}/);
    let calls = 0;
    child.mock.method(globalThis, "fetch", async () => { calls++; return apiResponse(); });
    assert.equal(await h.call("read", { path: "docs/note.md", limit: 20 }), undefined);
    // Assistant/tool messages advance the leaf but do not invalidate the user's task.
    h.entries.push({ id: "assistant", type: "message", message: { role: "assistant", content: "working" } });
    assert.equal(await h.call("read", { path: "docs/note.md" }), undefined);
    const status = await layerStatus(h);
    assert.equal(status.layers.jevRequests, l1Mode === "enforce" ? 0 : 2);
    assert.equal(status.layers.l1Allows, l1Mode === "enforce" ? 2 : 0);
    assert.equal(status.layers.l1Candidates, l1Mode === "off" ? 0 : 2);
    assert.equal(status.layers.comparedAllow, l1Mode === "observe" ? 2 : 0);
    assert.equal(calls, status.layers.jevRequests);
    for (const secret of ["private-task-text", "note.md", "test-key", "builtin:read"]) assert.equal(h.notifications.at(-1)!.includes(secret), false);
  });
});

test("observe retains Jev denial and excludes failed API calls from valid comparisons", async t => {
  const h = await scopedHarness(t, { JEV_L1_MODE: "observe" });
  await dispatchReadTask(h);
  t.mock.method(globalThis, "fetch", async () => apiResponse("unapproved"));
  assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("secret-provider-error"); });
  assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
  const { layers } = await layerStatus(h);
  assert.equal(layers.l1Candidates, 2);
  assert.equal(layers.l1Allows, 0);
  assert.equal(layers.jevRequests, 2);
  assert.equal(layers.comparedDeny, 1);
  assert.equal(layers.comparedReview, 0);
  assert.equal(layers.localFallbacks, 1);
});

test("no grant and same-name custom or missing tool origins always use Jev", async t => {
  const h = await scopedHarness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return apiResponse("unapproved"); });
  assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
  await dispatchReadTask(h);
  for (const sourceInfo of [undefined, { source: "extension", path: "custom:read" }]) {
    h.tools[1].sourceInfo = sourceInfo;
    assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
  }
  assert.equal(calls, 3);
});

test("scoped authorization does not bypass manual, shadow or missing-key behavior", async t => {
  const cases: Record<string, string>[] = [{ JEV_MODE: "manual" }, { JEV_MODE: "shadow" }, { TYPESAFE_API_KEY: "" }];
  for (const settings of cases) {
    await t.test(JSON.stringify(settings), async child => {
      const h = await scopedHarness(child, settings);
      await dispatchReadTask(h);
      let calls = 0;
      child.mock.method(globalThis, "fetch", async () => { calls++; return apiResponse("unapproved"); });
      const result = await h.call("read", { path: "docs/note.md" });
      assert.equal(result === undefined, settings.JEV_MODE === "shadow");
      assert.equal(calls, settings.JEV_MODE === "shadow" ? 1 : 0);
      assert.equal((await layerStatus(h)).layers.l1Allows, 0);
    });
  }
});

test("new input, completion, navigation, compaction and reload revoke a bound task", async t => {
  const h = await scopedHarness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return apiResponse("unapproved"); });
  for (const event of ["input", "agent_end", "session_shutdown", "session_before_switch", "session_before_fork",
    "session_before_tree", "session_tree", "session_before_compact", "session_compact", "session_compact_failed", "session_start"]) {
    await dispatchReadTask(h);
    assert.equal(await h.call("read", { path: "docs/note.md" }), undefined);
    await h.handlers.get(event)!({ text: "Do not read anything else", source: "interactive" }, h.ctx);
    assert.equal((await h.call("read", { path: "docs/note.md" })).block, true, event);
  }
  assert.equal(calls, 11);
});

test("user-history mutation, session or cwd replacement invalidates the binding", async t => {
  for (const change of ["history", "session", "cwd"]) await t.test(change, async child => {
    const h = await scopedHarness(child);
    await dispatchReadTask(h);
    assert.equal(await h.call("read", { path: "docs/note.md" }), undefined);
    if (change === "history") h.entries[0].message.content = "New restriction";
    if (change === "session") child.mock.method(h.ctx.sessionManager, "getSessionId", () => "replacement");
    if (change === "cwd") h.ctx.cwd = join(h.ctx.cwd, "docs");
    child.mock.method(globalThis, "fetch", async () => apiResponse("unapproved"));
    assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
    assert.equal((await layerStatus(h)).layers.l1Allows, 1);
  });
});

test("task rewriting, incorrect input provenance and replayed identity do not establish a grant", async t => {
  for (const change of ["input-source", "input-image", "prompt", "history-text", "history-id", "missing-history"]) await t.test(change, async child => {
    const h = await scopedHarness(child);
    await h.commands.get("jev").handler("read-task docs -- Read note.md", h.ctx);
    const text = h.sent[0];
    await h.handlers.get("input")!({ text, source: change === "input-source" ? "interactive" : "extension",
      images: change === "input-image" ? [{ type: "image" }] : undefined }, h.ctx);
    await h.handlers.get("before_agent_start")!({ prompt: change === "prompt" ? `${text} changed` : text }, h.ctx);
    if (change !== "missing-history") h.entries.push({ id: change === "history-id" ? "original-user" : "task-1",
      type: "message", message: { role: "user", content: change === "history-text" ? `${text} changed` : text } });
    child.mock.method(globalThis, "fetch", async () => apiResponse("unapproved"));
    assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
    assert.equal((await layerStatus(h)).layers.l1Allows, 0);
  });
});

test("read-task refuses busy, pending, headless, rejected, malformed and unprotected-scope failures", async t => {
  for (const condition of ["busy", "pending", "headless", "reject", "malformed", "outside", "protected", "unsupported-history", "missing-id"]) {
    await t.test(condition, async child => {
      const h = await scopedHarness(child);
      let command = "read-task docs -- Read note.md";
      if (condition === "busy") child.mock.method(h.ctx, "isIdle", () => false);
      if (condition === "pending") child.mock.method(h.ctx, "hasPendingMessages", () => true);
      if (condition === "headless") h.ctx.hasUI = false;
      if (condition === "reject") child.mock.method(h.ctx.ui, "confirm", async () => false);
      if (condition === "malformed") command = "read-task docs";
      if (condition === "outside") command = "read-task .. -- Read note.md";
      if (condition === "protected") { await mkdir(join(h.ctx.cwd, "jev-review")); command = "read-task jev-review -- Read note.md"; }
      if (condition === "unsupported-history") h.entries[0].message.content = [{ type: "image" }];
      if (condition === "missing-id") delete h.entries[0].id;
      await h.commands.get("jev").handler(command, h.ctx);
      assert.equal(h.sent.length, 0);
    });
  }
});

test("new input, queued messages, confirmation error or dispatch error cannot grant a task", async t => {
  for (const condition of ["input", "queued", "error", "dispatch"]) await t.test(condition, async child => {
    const h = await scopedHarness(child);
    child.mock.method(h.ctx.ui, "confirm", async () => {
      if (condition === "input") await h.handlers.get("input")!({ text: "new restriction", source: "interactive" }, h.ctx);
      if (condition === "queued") child.mock.method(h.ctx, "hasPendingMessages", () => true);
      if (condition === "error") throw new Error("closed");
      return true;
    });
    if (condition === "dispatch") child.mock.method(h.api, "sendUserMessage", () => { throw new Error("dispatch failed"); });
    await h.commands.get("jev").handler("read-task docs -- Read note.md", h.ctx);
    assert.equal(h.sent.length, 0);
    child.mock.method(globalThis, "fetch", async () => apiResponse("unapproved"));
    assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
  });
});

test("actual L1 reads remain bound to the unchanged payload and live task", async t => {
  for (const condition of ["parameters", "cancel", "input"]) await t.test(condition, async child => {
    const h = await scopedHarness(child);
    await dispatchReadTask(h);
    // Bind once, then change state during the classifier's final revalidation.
    assert.equal(await h.call("read", { path: "docs/note.md" }), undefined);
    const input = { path: "docs/note.md" };
    const controller = new AbortController(); h.ctx.signal = controller.signal;
    let snapshots = 0;
    child.mock.method(h.ctx.sessionManager, "getBranch", () => {
      if (++snapshots === 4) {
        if (condition === "parameters") input.path = "outside.md";
        if (condition === "cancel") controller.abort();
        if (condition === "input") void h.handlers.get("input")!({ text: "stop", source: "interactive" }, h.ctx);
      }
      return h.entries;
    });
    child.mock.method(globalThis, "fetch", async () => apiResponse());
    assert.equal((await h.call("read", input)).block, true);
    assert.equal((await layerStatus(h)).layers.l1Allows, 1);
  });
});

test("L1 mode changes revoke grants and invalid environment modes block the gate", async t => {
  const h = await scopedHarness(t);
  await dispatchReadTask(h);
  assert.equal(await h.call("read", { path: "docs/note.md" }), undefined);
  await h.commands.get("jev").handler("l1 observe", h.ctx);
  const status = await layerStatus(h);
  assert.equal(status.l1Mode, "observe");
  assert.equal(status.readTaskAuthorized, false);
  t.mock.method(globalThis, "fetch", async () => apiResponse("unapproved"));
  assert.equal((await h.call("read", { path: "docs/note.md" })).block, true);
  const invalid = harness(t, { JEV_L1_MODE: "typo" });
  assert.match((await invalid.call()).reason, /Invalid/);
});

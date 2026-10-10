import assert from "node:assert/strict";
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
  const ctx = {
    cwd: "/project", hasUI, signal: undefined as AbortSignal | undefined,
    ui: { setStatus() {}, notify(message: string) { notifications.push(message); }, async confirm(_title: string, _message: string, _options?: unknown) { return false; } },
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "Inspect project files" } }] },
  };
  const api = { on(name: string, handler: any) { handlers.set(name, handler); }, registerCommand(name: string, command: any) { commands.set(name, command); }, getAllTools() { return [{ name: "bash", description: "Execute shell commands" }]; } };
  jevReview(api as unknown as ExtensionAPI);
  const call = (tool = "bash", input: Record<string, unknown> = { command: "git status" }) => handlers.get("tool_call")!({ toolName: tool, input }, ctx);
  return { ctx, handlers, commands, notifications, call };
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

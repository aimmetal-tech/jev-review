import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { createMessage, createUserMessage, ToolCallId, type ContentBlock } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineContentToolFixture, type ToolExecutionToken } from "@deepseek-ai/dsh-tools";
import ApprovalService, { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import PermissionPresetService, { AUTO_PRESET } from "@deepseek-ai/dsh-permission-presets";
import * as NativeAutoReview from "@deepseek-ai/dsh-experimental-auto-review";
import * as Jev from "../src/adapters/dsh.ts";
import { QUESTIONS } from "../src/reviewer.ts";

function apiResponse(authorization: string, risk: string) {
  const answer = (choice: string, keys: string[]) => ({ type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, Number(key === choice)])) });
  return new Response(JSON.stringify({ model: "jev-1.13.0", answers: {
    authorization: answer(authorization, Object.keys(QUESTIONS.authorization.criteria)), risk: answer(risk, Object.keys(QUESTIONS.risk.criteria)),
  } }));
}

async function harness(t: TestContext) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  ctx.provide("shell", { sandboxMode: "workspace-write", resolve() { throw new Error("No shell calls in this fixture"); }, run() { throw new Error("No shell calls in this fixture"); }, start() { throw new Error("No shell calls in this fixture"); } });
  ctx.provide("workingDirectory", { ensure: async () => "/example/project" });
  await ctx.plugin(ApprovalService, { policy: "ask" });
  await ctx.plugin(PermissionPresetService, {
    presets: {
      "read-only": { sandbox: "read-only", approval: "ask", name: "Read only" },
      "workspace-write": { sandbox: "workspace-write", approval: "ask", name: "Workspace write" },
      "danger-full-access": { sandbox: "danger-full-access", approval: "never", name: "Full access" },
    }, defaultPreset: "workspace-write",
  });
  await ctx.plugin(NativeAutoReview);
  const saved = process.env.JEV_NATIVE_TEST_KEY;
  process.env.JEV_NATIVE_TEST_KEY = "test-key";
  t.after(() => { if (saved === undefined) delete process.env.JEV_NATIVE_TEST_KEY; else process.env.JEV_NATIVE_TEST_KEY = saved; });
  const jev = await ctx.plugin(Jev, { apiKeyEnv: "JEV_NATIVE_TEST_KEY" });

  let runs = 0;
  ctx.tools.register(defineContentToolFixture({
    name: "probe", description: "Read the project source file", parameters: { path: { type: "string" } },
    async execute() { runs++; return [{ type: "text", text: "probe ran" }]; },
  }));
  const session = ctx.sessions.create(SessionId(`jev-fixture-${t.name}`), { meta: { cwd: "/example/project" } });
  ctx.permissionPresets.set(session, AUTO_PRESET);
  const agent = { id: session.id, session, options: { provider: "main-provider", model: "main-model" } } as Agent;
  session.append("request/header", { header: { config: { provider: "main-provider", model: "main-model" }, tools: [{ name: "probe", description: "Read the project source file", parameters: { type: "object", properties: { path: { type: "string" } } } }] }, reason: "initial" });
  const source = { kind: "user" as const, rpcId: "fixture-user" };
  session.append("user/message", createUserMessage({ content: [{ type: "text", text: "Inspect project source files" }], source }), { surfaceOp: "append" });
  session.append("turn/start", { turn: 1 });

  let calls = 0;
  async function call(ptc = false) {
    const step = ++calls;
    const callId = ToolCallId(`call-${step}`);
    const rootName = ptc ? "run_code" : "probe";
    const raw = JSON.stringify(ptc ? { code: "tools.probe({path:'src/main.ts'})" } : { path: "src/main.ts" });
    const content: ContentBlock[] = [{ type: "tool-call", id: callId, name: rootName, arguments: raw }];
    session.append("step/start", { turn: 1, step });
    session.append("assistant/message", { turn: 1, step, stream: [], message: createMessage({ role: "assistant", content, source: { kind: "model", provider: "main-provider", model: "main-model" } }) }, { surfaceOp: "append" });
    session.append("tool/call", { turn: 1, step, callId, name: rootName, arguments: raw });
    if (ptc) {
      const innerId = ToolCallId(`${callId}:ptc:1`);
      session.append("tool/ptc-dispatch-start", { rootCallId: callId, parentCallId: callId, subCallId: innerId, name: "probe", arguments: { path: "src/main.ts" } });
      return ctx.tools.execute({ callId: innerId, rootCallId: callId, parent: Symbol("ptc-fixture") as ToolExecutionToken,
        name: "probe", schema: { name: "probe", description: "Read the project source file", parameters: { type: "object" } },
        arguments: { path: "src/main.ts" }, agent, signal: new AbortController().signal });
    }
    return ctx.tools.execute({ callId, name: "probe", arguments: { path: "src/main.ts" }, agent, signal: new AbortController().signal });
  }
  return { ctx, session, agent, jev, call, runs: () => runs };
}

test("real native Auto and tool runtime execute the body only after Jev allows", async t => {
  const h = await harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    assert.equal(body.state.operation.tool, "probe");
    assert.deepEqual(body.state.userRequests, ["Inspect project source files"]);
    return apiResponse("authorized", "routine");
  });
  const result = await h.call();
  assert.equal(result.isError, false);
  assert.equal(h.runs(), 1);
  assert.equal(calls, 1);
  assert.equal(h.ctx.permissionPresets.current(h.session), AUTO_PRESET);
});
test("native ask policy presents Jev denial and grants only explicit one-shot approval", async t => {
  const h = await harness(t);
  t.mock.method(globalThis, "fetch", async () => apiResponse("authorized", "sensitive"));
  let asks = 0;
  h.ctx.on("approval/request", async () => { asks++; return "allowed-once"; });
  const result = await h.call();
  assert.equal(result.isError, false, JSON.stringify({ result, asks }));
  assert.equal(h.runs(), 1);
  assert.equal(asks, 1);
  assert.ok(h.session.snapshotEvents().some(event => event.type === "approval/decided" && event.data.outcome === "allowed-once"));
});
test("native never policy denies Jev rejection without executing or prompting", async t => {
  const h = await harness(t);
  setApprovalPolicy(h.session, "never");
  t.mock.method(globalThis, "fetch", async () => apiResponse("unapproved", "routine"));
  h.ctx.on("approval/request", async () => { assert.fail("Never policy cannot prompt"); });
  assert.equal((await h.call()).isError, true);
  assert.equal(h.runs(), 0);
});
test("native ask with no answerer remains fail-closed on Jev outage", async t => {
  const h = await harness(t);
  t.mock.method(globalThis, "fetch", async () => new Response("outage", { status: 503 }));
  assert.equal((await h.call()).isError, true);
  assert.equal(h.runs(), 0);
});
test("native PTC inner dispatch reaches Jev with its bound schema before the body", async t => {
  const h = await harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    assert.equal(body.state.operation.executionMode, "ptc-inner");
    assert.equal(body.state.operation.tool, "probe");
    return apiResponse("authorized", "routine");
  });
  const result = await h.call(true);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(h.runs(), 1);
});

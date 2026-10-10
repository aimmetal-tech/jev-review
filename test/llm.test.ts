import assert from "node:assert/strict";
import { test } from "node:test";
import { LLM_POLICY, parseLLMDecision, readLLMConfig, reviewLLM } from "../src/llm.ts";
import { readConfig, review, QUESTIONS, type ReviewState } from "../src/reviewer.ts";

const state: ReviewState = { operation: { tool: "bash", source: "agent", cwd: "/project", input: { command: "npm install" } },
  userRequests: ["Install project dependencies"], incompleteContext: false };
const llm = readLLMConfig({ MIMO_TP_KEY: "mock-llm-key" });
function result(decision = "allow", authorization = "authorized", risk = "sensitive") {
  return { model: "mimo-v2.5-pro", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision, authorization, risk,
    reason: "private provider prose", saferAlternative: "private injected alternative" }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } };
}
function jev(risk: string, authorization = "authorized") {
  const answer = (choice: string, keys: string[]) => ({ type: "choice", choice, confidence: 1,
    probabilities: Object.fromEntries(keys.map(key => [key, Number(choice === key)])) });
  return Response.json({ model: "jev-1.13.0", answers: { authorization: answer(authorization, Object.keys(QUESTIONS.authorization.criteria)),
    risk: answer(risk, Object.keys(QUESTIONS.risk.criteria)) } });
}

test("fallback uses the configured independent OpenAI-compatible reviewer and strict JSON", async () => {
  let calls = 0;
  const verdict = await reviewLLM(state, llm, async (url, init) => {
    calls++;
    assert.equal(url, "https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer mock-llm-key");
    assert.equal(init!.redirect, "error");
    const request = JSON.parse(init!.body as string);
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.equal(request.messages[0].content, LLM_POLICY);
    assert.deepEqual(JSON.parse(request.messages[1].content), state);
    return Response.json(result());
  });
  assert.equal(calls, 1);
  assert.equal(verdict.source, "llm");
  assert.equal(verdict.decision, "allow");
  assert.deepEqual(verdict.usage, { input_tokens: 20, output_tokens: 10 });
  assert.equal(verdict.reason.includes("private"), false);
});

test("Jev runs first; a fast approval skips LLM and all other results get a final opinion", async () => {
  const config = readConfig({ TYPESAFE_API_KEY: "mock-jev-key", MIMO_TP_KEY: "mock-llm-key" });
  for (const [risk, authorization, expected] of [["routine", "authorized", "allow"], ["routine", "unapproved", "allow"], ["sensitive", "authorized", "allow"]]) {
    const urls: string[] = [];
    const verdict = await review(state, config, async url => { urls.push(String(url)); return urls.length === 1 ? jev(risk, authorization) : Response.json(result()); });
    assert.equal(verdict.decision, expected);
    assert.equal(urls[0], "https://api.typesafe.ai/v1/systemone");
    const fallback=risk!=="routine"||authorization!=="authorized";
    assert.equal(urls.length, fallback ? 2 : 1);
    assert.equal(verdict.source, fallback ? "llm" : "jev");
  }
});

test("Jev transport or parsing failure can recover via the independent final reviewer", async () => {
  const config = readConfig({ TYPESAFE_API_KEY: "mock-jev-key", MIMO_TP_KEY: "mock-llm-key" });
  for (const failure of [() => new Response("secret-error", { status: 503 }), () => new Response("invalid JSON"), () => { throw new Error("secret exception"); }]) {
    let calls = 0;
    const verdict = await review(state, config, async () => ++calls === 1 ? failure() : Response.json(result()));
    assert.equal(calls, 2);
    assert.equal(verdict.source, "llm");
    assert.equal(verdict.decision, "allow");
  }
  const verdict = await review(state, readConfig({ MIMO_TP_KEY: "mock-llm-key" }), async () => Response.json(result()));
  assert.equal(verdict.source, "llm");
  assert.equal(verdict.decision, "allow");
});

test("unavailable reviewers, cancellations and incomplete evidence never auto-approve", async () => {
  const config = readConfig({ TYPESAFE_API_KEY: "mock-jev-key", MIMO_TP_KEY: "mock-llm-key" });
  for (const input of [{ ...state, incompleteContext: true }, { ...state, userRequests: ["x".repeat(40000)] },
    { ...state, operation: { ...state.operation, input: { path: ".env" } } }]) {
    const verdict = await review(input, config, async () => { assert.fail("Incomplete/private snapshots cannot call reviewers"); });
    assert.equal(verdict.decision, "review");
  }
  assert.equal((await reviewLLM(state, llm, async () => { assert.fail("Cancelled call"); }, AbortSignal.abort())).decision, "review");
  assert.equal((await reviewLLM(state, { ...llm, apiKey: undefined }, async () => { assert.fail("No key"); })).decision, "review");
  for (const body of [new Response("server secret", { status: 503 }), new Response("bad json"), new Response("x".repeat(131073))]) {
    const verdict = await reviewLLM(state, llm, async () => body);
    assert.equal(verdict.decision, "review");
    assert.equal(verdict.reason.includes("secret"), false);
  }
});

test("malformed, contradictory, truncated and tool-calling final decisions are rejected", () => {
  const corruptions: ((value: any) => void)[] = [
    value => { value.choices = []; }, value => { value.choices[0].finish_reason = "length"; },
    value => { value.choices[0].message.tool_calls = [{ function: { name: "approve" } }]; },
    value => { value.choices[0].message.content = "```json\n{}\n```"; },
    value => { value.choices[0].message.content = JSON.stringify({ decision: "allow", authorization: "unapproved", risk: "routine", reason: "bad", saferAlternative: null }); },
    value => { value.choices[0].message.content = JSON.stringify({ decision: "allow", authorization: "authorized", risk: "unknown", reason: "bad", saferAlternative: null }); },
    value => { value.choices[0].message.content = JSON.stringify({ decision: ["deny"], authorization: "authorized", risk: "unknown", reason: "bad", saferAlternative: null }); },
    value => { value.choices[0].message.content = JSON.stringify({ decision: "allow", authorization: "authorized", risk: "routine", reason: "bad", saferAlternative: null, extra: true }); },
  ];
  for (const corrupt of corruptions) { const value = result(); corrupt(value); assert.throws(() => parseLLMDecision(value)); }
  const denied = parseLLMDecision(result("deny", "unapproved"));
  assert.equal(denied.decision, "deny");
  assert.equal(denied.alternative!.includes("private"), false);
});

test("final review timeout aborts the request and does not expose provider data", async () => {
  const verdict = await reviewLLM(state, { ...llm, timeoutMs: 10 }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("secret abort")), { once: true });
  }));
  assert.equal(verdict.decision, "review");
  assert.match(verdict.reason, /timed out/);
});

test("LLM endpoint and configuration do not allow key-leaking URLs", () => {
  for (const env of [{ JEV_LLM_BASE_URL: "http://example.com" }, { JEV_LLM_BASE_URL: "https://key@example.com" },
    { JEV_LLM_BASE_URL: "https://example.com?key=value" }, { JEV_LLM_MODEL: "" }, { JEV_LLM_TIMEOUT_MS: "NaN" }]) {
    assert.throws(() => readLLMConfig(env));
  }
});

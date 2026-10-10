import { createHash } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { readConfig, review, type Config as ReviewConfig, type ReviewState } from "../reviewer.ts";

export const name = "jev-auto-review";
export const inject = ["llm"];

// The verified native protocol is identical in dsh 0.2.0-rc.2 and 0.2.1-alpha.2.
// An upstream policy change requires a deliberate compatibility review.
export const REVIEW_POLICY_SHA256 = "1ee45271ed0609302c859061c0d9830903aaec51db872e97da50d2da1c388ec0";

export const Config = z.object({
  apiKeyEnv: z.string().default("TYPESAFE_API_KEY").description("Environment variable holding the TypeSafe key"),
  model: z.string().default("jev-1.13.0"),
  mode: z.union([z.const("auto"), z.const("manual"), z.const("shadow")]).default("auto"),
  probabilityThreshold: z.number().min(0.5).max(1).default(0.98),
  confidenceThreshold: z.number().min(0.5).max(1).default(0.95),
  timeoutMs: z.natural().min(100).max(60000).default(5000),
  maxStateBytes: z.natural().min(1024).max(131072).default(32768),
});
export type DshConfig = ReturnType<typeof Config>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the native review's four labelled JSON sections, retaining authority roles. */
export function translateReviewInput(options: GenerateOptions): ReviewState {
  if (typeof options.system !== "string" || createHash("sha256").update(options.system).digest("hex") !== REVIEW_POLICY_SHA256) {
    throw new Error("Unsupported dsh auto-review policy; update the Jev adapter before using this dsh version");
  }
  const message = options.messages[0];
  if (options.messages.length !== 1 || message?.role !== "user" || message.id !== undefined || message.source !== undefined ||
      message.content.length !== 1 || message.content[0]?.type !== "text" || options.tools !== undefined) {
    throw new Error("Unsupported dsh auto-review request shape");
  }
  const sections = /^ENVIRONMENT\n\n([\s\S]*?)\n\nPROJECT_INSTRUCTIONS\n\n([\s\S]*?)\n\nFILTERED_HISTORY\n\n([\s\S]*?)\n\nPENDING_ACTION\n\n([\s\S]+)$/.exec(message.content[0].text);
  if (!sections) throw new Error("Unsupported dsh auto-review sections");
  const environment: unknown = JSON.parse(sections[1]);
  const project: unknown = JSON.parse(sections[2]);
  const history: unknown = JSON.parse(sections[3]);
  const action: unknown = JSON.parse(sections[4]);
  if (!record(environment) || typeof environment.cwd !== "string" || !Array.isArray(project) || !Array.isArray(history) ||
      !record(action) || typeof action.name !== "string" || typeof action.description !== "string" || !record(action.parameters) ||
      (action.mode !== "native" && action.mode !== "ptc-inner")) {
    throw new Error("Invalid dsh auto-review snapshot");
  }
  const state: ReviewState = {
    operation: { tool: action.name, description: action.description, parameters: action.parameters, executionMode: action.mode,
      input: record(action.arguments) ? action.arguments : { arguments: action.arguments }, cwd: environment.cwd, source: "agent" },
    userRequests: [], parentRequests: [], constraints: [], incompleteContext: !record(action.arguments),
  };
  function retain(entry: unknown, projectConstraint: boolean) {
    if (!record(entry) || typeof entry.role !== "string") throw new Error("Invalid dsh review history");
    if (entry.kind === "tool-call" && entry.role === "fact") return;
    if (entry.kind !== "user-message" || !Array.isArray(entry.content)) throw new Error("Invalid dsh review history entry");
    if (projectConstraint && entry.role !== "constraint") throw new Error("Invalid dsh project constraint role");
    if (entry.role === "checkpoint") state.incompleteContext = true;
    for (const block of entry.content) {
      if (!record(block) || block.type !== "text" || typeof block.text !== "string") {
        state.incompleteContext = true;
        continue;
      }
      switch (entry.role) {
        case "human-instruction": state.userRequests.push(block.text); break;
        case "direct-parent-instruction": state.parentRequests!.push(block.text); break;
        case "constraint": state.constraints!.push(block.text); break;
        case "checkpoint": state.incompleteContext = true; break;
        case "fact": break; // Tool output and other facts cannot become authorization.
        default: throw new Error("Unsupported dsh review authority role");
      }
    }
  }
  project.forEach(entry => retain(entry, true));
  history.forEach(entry => retain(entry, false));
  return state;
}

function failure(message: string, aborted = false): StreamChunk {
  return { type: "finish", reason: { kind: aborted ? "aborted" : "error", failure: { code: aborted ? "ABORTED" : "JEV_REVIEW_PROTOCOL", message } } };
}

/** Render the exact protocol consumed by dsh's own Auto reviewer. */
export async function* reviewStream(options: GenerateOptions, config: ReviewConfig, fetcher: typeof fetch = fetch): AsyncIterable<StreamChunk> {
  if (options.signal?.aborted) { yield failure("Jev review cancelled", true); return; }
  let state: ReviewState;
  try { state = translateReviewInput(options); }
  catch { yield failure("Unsupported dsh review protocol; Jev did not approve this operation"); return; }
  const verdict = await review(state, config, fetcher, options.signal);
  if (options.signal?.aborted) { yield failure("Jev review cancelled", true); return; }
  const text = JSON.stringify(verdict.decision === "allow"
    ? { risk: "low", decision: "allow" }
    : { risk: "medium", decision: "deny", reason: `Jev: ${verdict.reason}` });
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text };
  yield { type: "block-end", index: 0, block: { type: "text", text } };
  if (verdict.usage) yield { type: "usage", usage: { inputTokens: verdict.usage.input_tokens, outputTokens: verdict.usage.output_tokens } };
  yield { type: "finish", reason: { kind: "stop" } };
}

/** Intercept only the native one-shot Auto review; ordinary agent requests delegate unchanged. */
export function apply(ctx: Context, config: DshConfig): void {
  // Cordis validates the exported Config at activation. readConfig also validates model spelling.
  const resolved = readConfig({
    TYPESAFE_API_KEY: process.env[config.apiKeyEnv],
    JEV_MODEL: config.model, JEV_MODE: config.mode,
    JEV_PROBABILITY_THRESHOLD: String(config.probabilityThreshold),
    JEV_CONFIDENCE_THRESHOLD: String(config.confidenceThreshold),
    JEV_TIMEOUT_MS: String(config.timeoutMs), JEV_MAX_STATE_BYTES: String(config.maxStateBytes),
  });
  const lifecycle = new AbortController();
  const active = new Set<Promise<void>>();
  const logger = ctx.logger("jev-auto-review");
  ctx.on("llm/stream", (options, next) => {
    if (!options.system?.startsWith("REVIEW_POLICY\n")) return next();
    return (async function* (): AsyncIterable<StreamChunk> {
      const done = Promise.withResolvers<void>();
      active.add(done.promise);
      const signal = options.signal ? AbortSignal.any([options.signal, lifecycle.signal]) : lifecycle.signal;
      try {
        if (resolved.mode === "shadow") {
          // Validate before delegating; never silently route an unsupported protocol.
          const state = translateReviewInput(options);
          const verdict = await review(state, resolved, fetch, signal);
          logger.info(`Jev shadow: ${verdict.decision}; ${verdict.reason}`);
        } else {
          yield* reviewStream({ ...options, signal }, resolved);
        }
      } catch {
        yield failure("Jev adapter failed; this operation was not approved", signal.aborted);
        return;
      } finally {
        active.delete(done.promise);
        done.resolve();
      }
      // Shadow retains the original native reviewer as the enforcing decision.
      if (resolved.mode === "shadow") {
        if (signal.aborted) { yield failure("Jev review cancelled", true); return; }
        yield* next();
      }
    })();
  }, { prepend: true });
  ctx.effect(() => async () => {
    lifecycle.abort();
    await Promise.allSettled(active);
  }, "Jev review requests");
}

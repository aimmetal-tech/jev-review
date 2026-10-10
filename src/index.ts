import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectUserContext, readConfig, review, type Mode, type Operation, type Verdict } from "./reviewer.ts";

export default function jevReview(pi: ExtensionAPI) {
  let config: ReturnType<typeof readConfig> | undefined;
  try { config = readConfig(process.env); } catch { /* Keep the gate installed when config is invalid. */ }
  const stats = { calls: 0, allow: 0, deny: 0, review: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 };
  let last: Verdict | undefined;

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus("jev-review", config ? `Jev: ${config.mode}` : "Jev: invalid config (blocked)");
  }

  async function gate(operation: Operation, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
    if (!config) return { block: true, reason: "Invalid Jev configuration. Fix the JEV_* environment variables and reload the extension." };
    const callConfig = config;
    if (ctx.signal?.aborted) return { block: true, reason: "Review cancelled" };
    // Capture the exact payload shown to Jev/the user; detect concurrent input changes.
    let snapshot: string;
    let captured: Operation;
    try {
      snapshot = JSON.stringify(operation.input);
      captured = { ...operation, input: JSON.parse(snapshot) };
    } catch { return { block: true, reason: "Tool input cannot be serialized for review" }; }
    const context = collectUserContext(ctx.sessionManager.getBranch());
    const started = Date.now();
    const verdict = await review({ operation: captured, ...context }, callConfig, fetch, ctx.signal);
    last = verdict;
    stats.calls++;
    stats[verdict.decision]++;
    stats.inputTokens += verdict.usage?.input_tokens ?? 0;
    stats.outputTokens += verdict.usage?.output_tokens ?? 0;
    stats.totalMs += Date.now() - started;

    function changedOrCancelled() {
      if (ctx.signal?.aborted) return true;
      try { return JSON.stringify(operation.input) !== snapshot; } catch { return true; }
    }
    if (changedOrCancelled()) return { block: true, reason: "Operation changed or review was cancelled" };

    if (callConfig.mode === "shadow") {
      ctx.ui.notify(`Jev shadow: ${verdict.decision} — ${verdict.reason}`, "warning");
      return undefined;
    }
    if (verdict.decision === "allow") return undefined;
    if (verdict.decision === "deny") return { block: true, reason: `Jev: ${verdict.reason}` };
    if (!ctx.hasUI) return { block: true, reason: `Jev: ${verdict.reason}. Interactive approval is required.` };

    // Serialize dialogs so concurrent calls do not replace each other's approval UI.
    return enqueueApproval(async () => {
      if (changedOrCancelled()) return { block: true, reason: "Operation changed or review was cancelled" };
      let approved = false;
      try {
        approved = await ctx.ui.confirm(
          "Jev: approve this operation once?",
          `${verdict.reason}\n\n${JSON.stringify(captured, null, 2)}`,
          { signal: ctx.signal },
        );
      } catch { /* Closed/failed dialogs never grant approval. */ }
      if (changedOrCancelled()) return { block: true, reason: "Operation changed or review was cancelled" };
      return approved ? undefined : { block: true, reason: "Jev: operation was not approved by the user" };
    });
  }

  let approvalQueue: Promise<unknown> = Promise.resolve();
  function enqueueApproval<T>(task: () => Promise<T>): Promise<T> {
    const result = approvalQueue.then(task, task);
    approvalQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  pi.on("session_start", async (_event, ctx) => {
    status(ctx);
    if (!config) ctx.ui.notify("Jev configuration is invalid; tool calls will be blocked.", "error");
    else if (config.mode === "shadow") ctx.ui.notify("Jev shadow mode observes decisions and does not enforce them.", "warning");
    else if (!config.apiKey && config.mode !== "manual") ctx.ui.notify("Set TYPESAFE_API_KEY to enable Jev. Tool calls currently require manual approval.", "warning");
  });

  pi.on("tool_call", async (event, ctx) => {
    const description = pi.getAllTools().find(tool => tool.name === event.toolName)?.description;
    return gate({ tool: event.toolName, input: event.input, cwd: ctx.cwd, description, source: "agent" }, ctx);
  });

  pi.on("user_bash", async (event, ctx) => {
    // Explicit user ! / !! commands are opt-in. Invalid config blocks this path too.
    if (config && !config.reviewUserBash) return undefined;
    const result = await gate({ tool: "bash", input: { command: event.command }, cwd: event.cwd, source: "user_bash" }, ctx);
    if (!result) return undefined;
    return { result: { output: result.reason, exitCode: 1, cancelled: false, truncated: false } };
  });

  pi.registerCommand("jev", {
    description: "Jev review status; /jev mode auto|manual|shadow",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "mode" && parts.length === 2 && ["auto", "manual", "shadow"].includes(parts[1])) {
        if (!config) {
          ctx.ui.notify("Fix the JEV_* environment variables and reload first.", "error");
          return;
        }
        const next = parts[1] as Mode;
        if (next === "shadow" && config.mode !== "shadow") {
          if (!ctx.hasUI || !(await ctx.ui.confirm("Enable Jev shadow mode?", "Shadow mode lets operations execute regardless of Jev's decision. It is for evaluation only."))) return;
        }
        config = { ...config, mode: next };
        status(ctx);
        ctx.ui.notify(`Jev mode: ${next}`, next === "shadow" ? "warning" : "info");
        return;
      }
      if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify("Usage: /jev [status] | /jev mode auto|manual|shadow", "warning");
        return;
      }
      ctx.ui.notify(JSON.stringify({
        mode: config?.mode ?? "invalid", model: config?.model, configured: Boolean(config?.apiKey),
        thresholds: config && { probability: config.probabilityThreshold, confidence: config.confidenceThreshold },
        stats: { ...stats, meanReviewMs: stats.calls ? Math.round(stats.totalMs / stats.calls) : 0 },
        last,
      }, null, 2), "info");
    },
  });
}

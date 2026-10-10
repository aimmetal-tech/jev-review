import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadScope, type L1Context, type L1Mode, type ReadScope } from "../l1.ts";
import { DockerSandbox, SANDBOX_TOOL_NAMES, sandboxSchema, sandboxBoundary, type SandboxPlan } from "../sandbox.ts";
import { RecoveryBudget } from "../recovery.ts";
import { collectUserContext, readConfig, review, type Mode, type Operation, type Verdict } from "../reviewer.ts";

export default function jevReview(pi: ExtensionAPI) {
  let config: ReturnType<typeof readConfig> | undefined;
  try { config = readConfig(process.env); } catch { /* Keep the gate installed when config is invalid. */ }
  const stats = { calls: 0, allow: 0, deny: 0, review: 0, inputTokens: 0, outputTokens: 0, totalMs: 0 };
  const layers = { l1Candidates: 0, l1Allows: 0, jevRequests: 0, llmRequests: 0, sandboxAllows: 0, humanRequests: 0, localFallbacks: 0, comparedAllow: 0, comparedDeny: 0, comparedReview: 0 };
  const sandbox=config?new DockerSandbox(config.sandbox):undefined;
  const recovery=new RecoveryBudget();
  const owned=new Map<string,{parameters:unknown;source?:string;description:string}>();
  const workspaces=new Map<string,string>();
  const pending=new Map<string,{plan:SandboxPlan;approved:boolean;epoch:number;session:string}>();
  let last: Verdict | undefined;
  let epoch = 0;
  interface Snapshot { session: string; cwd: string; users: { id: string; value: string; text?: string }[] }
  interface Grant {
    scope: ReadScope;
    baseline: Snapshot;
    task: string;
    epoch: number;
    phase: "dispatch" | "input" | "prompt" | "bound";
    bound?: Snapshot;
  }
  let grant: Grant | undefined;

  function revoke() { epoch++; grant = undefined; recovery.reset(); pending.clear(); }
  function snapshotContext(ctx: ExtensionContext): Snapshot {
    const users = ctx.sessionManager.getBranch().flatMap(entry => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      if (!entry.id) throw new Error("Missing message identity");
      const content = entry.message.content;
      const text = typeof content === "string" ? content :
        content.length === 1 && content[0].type === "text" ? content[0].text : undefined;
      return [{ id: entry.id, value: JSON.stringify(entry.message), text }];
    });
    return { session: ctx.sessionManager.getSessionId(), cwd: resolve(ctx.cwd), users };
  }
  function same(a: Snapshot, b: Snapshot) { return JSON.stringify(a) === JSON.stringify(b); }
  function matches(ctx: ExtensionContext, expected: Snapshot): boolean {
    try { return same(snapshotContext(ctx), expected); } catch { return false; }
  }
  function validGrant(ctx: ExtensionContext, expected: Grant): boolean {
    if (grant !== expected || expected.epoch !== epoch) return false;
    try {
      const current = snapshotContext(ctx);
      if (expected.phase === "prompt") {
        const { users, ...identity } = current;
        const latest = users.at(-1);
        if (!latest || latest.text !== expected.task || users.length !== expected.baseline.users.length + 1 ||
            !same({ ...identity, users: users.slice(0, -1) }, expected.baseline) ||
            expected.baseline.users.some(user => user.id === latest.id)) { revoke(); return false; }
        expected.bound = current;
        expected.phase = "bound";
      }
      if (expected.phase !== "bound" || !expected.bound || !same(current, expected.bound)) { revoke(); return false; }
      return true;
    } catch { revoke(); return false; }
  }

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus("jev-review", config ? `Jev: ${config.mode}` : "Jev: invalid config (blocked)");
  }

  async function gate(operation: Operation, ctx: ExtensionContext, toolCallId?:string): Promise<{ block: true; reason: string } | undefined> {
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
    let execution: {plan:SandboxPlan;approved:boolean;epoch:number;session:string}|undefined;
    const preparationEpoch=epoch;
    const installed=owned.get(operation.tool),visible=pi.getAllTools().find(t=>t.name===operation.tool);
    if(sandbox&&installed&&(visible?.parameters===installed.parameters||Boolean(installed.source&&visible?.sourceInfo?.path===installed.source))) {
      try {
        const workspace=workspaces.get(ctx.sessionManager.getSessionId());if(!workspace)return {block:true,reason:"Standing sandbox workspace is not initialized"};
        const plan=await sandbox.prepare(captured,false,workspace);
        if(!plan)return {block:true,reason:"Unsupported sandbox operation"};
        if(preparationEpoch!==epoch||ctx.signal?.aborted)return {block:true,reason:"Sandbox operation was cancelled before review"};
        execution={plan,approved:false,epoch,session:ctx.sessionManager.getSessionId()};if(toolCallId)pending.set(toolCallId,execution);
      } catch { return {block:true,reason:"Sandbox is unavailable or the request is invalid. Fix the sandbox or choose a safer supported operation; execution was not performed."}; }
    }
    const currentGrant = grant;
    const provenance = pi.getAllTools().find(tool => tool.name === operation.tool)?.sourceInfo;
    const l1: L1Context | undefined = currentGrant && provenance && validGrant(ctx, currentGrant) ? {
      host: "pi", provenance: { source: provenance.source, path: provenance.path }, scope: currentGrant.scope,
      isValid: () => validGrant(ctx, currentGrant),
    } : undefined;
    const callEpoch = epoch;
    const started = Date.now();
    const verdict = await review({ operation: captured, ...context,...(execution?{sandboxBoundary:sandboxBoundary(execution.plan)}:{}) }, callConfig, fetch, ctx.signal, {
      l1, onJevRequest: () => { layers.jevRequests++; },onLLMRequest:()=>{layers.llmRequests++;},
      sandbox:execution?{allows:()=>execution!.epoch===epoch&&Boolean(sandbox?.canRun(execution!.plan,captured))}:undefined,
    });
    last = verdict;
    stats.calls++;
    stats[verdict.decision]++;
    stats.inputTokens += verdict.usage?.input_tokens ?? 0;
    stats.outputTokens += verdict.usage?.output_tokens ?? 0;
    stats.totalMs += Date.now() - started;
    if (verdict.source === "local") layers.localFallbacks++;
    if (verdict.l1Candidate) {
      layers.l1Candidates++;
      if (verdict.source === "jev") {
        if (verdict.decision === "allow") layers.comparedAllow++;
        else if (verdict.decision === "deny") layers.comparedDeny++;
        else layers.comparedReview++;
      }
    }

    function changedOrCancelled() {
      if (callEpoch !== epoch) return true;
      try { return Boolean(ctx.signal?.aborted) || JSON.stringify(operation.input) !== snapshot; } catch { return true; }
    }
    if (changedOrCancelled()) return { block: true, reason: "Operation changed or review was cancelled" };
    if (verdict.source === "l1" && (!currentGrant || !validGrant(ctx, currentGrant))) {
      return { block: true, reason: "L1 task authorization expired" };
    }

    if (callConfig.mode === "shadow") {
      ctx.ui.notify(`Jev shadow: ${verdict.decision} — ${verdict.reason}`, "warning");
      return undefined;
    }
    if (verdict.decision === "allow") {
      recovery.reset();
      if(execution)execution.approved=true;
      if(verdict.source==="sandbox")layers.sandboxAllows++;
      if (verdict.source === "l1") layers.l1Allows++;
      return undefined;
    }
    const recoveryResult=callConfig.mode==="manual"?{human:true,reason:verdict.reason}:recovery.outcome(verdict,callConfig.humanAfter);
    if (verdict.decision === "deny" || !recoveryResult.human) return { block: true, reason: `Auto review: ${recoveryResult.reason}` };
    if (!ctx.hasUI) return { block: true, reason: `Jev: ${verdict.reason}. Interactive approval is required.` };

    // Serialize dialogs so concurrent calls do not replace each other's approval UI.
    return enqueueApproval(async () => {
      if (changedOrCancelled()) return { block: true, reason: "Operation changed or review was cancelled" };
      let approved = false;
      try {
        layers.humanRequests++;
        approved = await ctx.ui.confirm(
          "Jev: approve this operation once?",
          `${verdict.reason}\n\n${JSON.stringify(captured, null, 2)}`,
          { signal: ctx.signal },
        );
      } catch { /* Closed/failed dialogs never grant approval. */ }
      if (changedOrCancelled()) return { block: true, reason: "Operation changed or review was cancelled" };
      if(approved){recovery.reset();if(execution)execution.approved=true;}
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
    revoke();
    status(ctx);
    if (!config) ctx.ui.notify("Jev configuration is invalid; tool calls will be blocked.", "error");
    else if (config.mode === "shadow") ctx.ui.notify("Jev shadow mode observes decisions and does not enforce them.", "warning");
    else if (!config.apiKey && !config.llm.apiKey && config.mode !== "manual") ctx.ui.notify("Review models are not configured. Verified standing sandbox operations remain available; unresolved exceptions are rejected before last-resort manual approval.", "warning");
    if(config?.sandbox.mode!=="off"&&sandbox) {
      workspaces.set(ctx.sessionManager.getSessionId(),ctx.sessionManager.getCwd());
      for(const original of pi.getAllTools()) {
        if(!SANDBOX_TOOL_NAMES.includes(original.name as typeof SANDBOX_TOOL_NAMES[number])||owned.has(original.name)||original.sourceInfo?.source!=="builtin")continue;
        const parameters=sandboxSchema(original.parameters),description=`${original.description}\nExecution is confined by Jev's Docker sandbox. Shell cwd is /workspace; filesystem paths use host paths. `+
          "Request only specific read_roots/writable_roots or network_access with justification when wider access is necessary; extra roots are mounted at /extra/<index>.";
        owned.set(original.name,{parameters,description});
        pi.registerTool({name:original.name,label:original.name,description,parameters,
          async execute(callId,params,signal,_update,executionContext) {
            const entry=pending.get(callId);pending.delete(callId);
            if(!entry||entry.epoch!==epoch||entry.session!==executionContext.sessionManager.getSessionId())throw new Error("Sandbox permission binding expired; the tool was not executed");
            const operation={...entry.plan.operation,input:params as Record<string,unknown>,cwd:executionContext.cwd};
            const result=await sandbox.execute(entry.plan,operation,entry.approved,signal);
            if(result.isError)throw new Error(result.text||"Sandbox command failed");
            return {content:[{type:"text",text:result.text}],details:{sandbox:true,exitCode:result.exitCode}};
          }});
        owned.get(original.name)!.source=pi.getAllTools().find(t=>t.name===original.name)?.sourceInfo?.path;
      }
    }
  });

  const invalidate = async () => { revoke(); };
  pi.on("session_shutdown", async()=>{revoke();await sandbox?.dispose();});
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("session_before_compact", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("session_compact_failed", invalidate);
  pi.on("agent_end", invalidate);
  pi.on("input", async (event, ctx) => {
    if (grant?.phase === "dispatch" && grant.epoch === epoch && event.source === "extension" &&
        event.text === grant.task && !event.images?.length && matches(ctx, grant.baseline)) {
      grant.phase = "input";
    } else revoke();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (grant?.phase === "input" && grant.epoch === epoch && event.prompt === grant.task && matches(ctx, grant.baseline)) {
      grant.phase = "prompt";
    } else revoke();
  });

  pi.on("tool_call", async (event, ctx) => {
    const description = pi.getAllTools().find(tool => tool.name === event.toolName)?.description;
    return gate({ tool: event.toolName, input: event.input, cwd: ctx.cwd, description, source: "agent" }, ctx,event.toolCallId);
  });

  pi.on("user_bash", async (event, ctx) => {
    // Explicit user ! / !! commands are opt-in. Invalid config blocks this path too.
    if (config && !config.reviewUserBash) return undefined;
    const result = await gate({ tool: "bash", input: { command: event.command }, cwd: event.cwd, source: "user_bash" }, ctx);
    if (!result) return undefined;
    return { result: { output: result.reason, exitCode: 1, cancelled: false, truncated: false } };
  });

  pi.registerCommand("jev", {
    description: "Jev status, mode, L1 mode, and UI-confirmed scoped read tasks",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "read-task") {
        revoke();
        const request = /^read-task\s+([\s\S]+?)\s+--\s+([\s\S]+)$/.exec(args.trim());
        if (!config || !request || !ctx.hasUI) {
          ctx.ui.notify("Read-task requires valid configuration, interactive confirmation, and: /jev read-task <directory> -- <task>", "error");
          return;
        }
        try {
          if (!ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted) {
            ctx.ui.notify("Read-task requires an idle session with no pending messages.", "warning"); return;
          }
          const baseline = snapshotContext(ctx), confirmedEpoch = epoch, confirmedConfig = config;
          if (collectUserContext(ctx.sessionManager.getBranch()).incompleteContext) {
            ctx.ui.notify("Read-task requires complete text-only user context.", "warning"); return;
          }
          const scope = await createReadScope(ctx.cwd, request[1].trim());
          if (!scope) { ctx.ui.notify("Read-task requires an existing, unprotected, unlinked subdirectory of the workspace.", "warning"); return; }
          const task = `${request[2].trim()}\n\nJev UI-confirmed read authorization: built-in read of ordinary files under ${scope.root}. ` +
            "This newer scoped read authorization replaces earlier read restrictions within this directory. Protected paths remain excluded; " +
            "other operations use normal approval. Subsequent input revokes this grant.\n" + `Jev task ID: ${randomUUID()}`;
          const unchanged = () => epoch === confirmedEpoch && config === confirmedConfig && matches(ctx, baseline) &&
            ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.signal?.aborted;
          await enqueueApproval(async () => {
            if (!unchanged()) return;
            const approved = await ctx.ui.confirm("Jev: authorize this scoped read task?",
              `${task}\n\nL1 mode: ${confirmedConfig.l1Mode}. Only auto + enforce can bypass Jev; ` +
              "observe still uses Jev. Credential/configuration paths, plugin directories, links and files outside this scope are excluded. " +
              "Fast approval trusts the standard Pi CLI built-in read contract; custom SDK executors are unsupported.", { signal: ctx.signal });
            if (!approved || !unchanged()) return;
            grant = { scope, baseline, task, epoch: confirmedEpoch, phase: "dispatch" };
            pi.sendUserMessage(task, { expandPromptTemplates: false });
          });
        } catch { revoke(); ctx.ui.notify("Read-task was not authorized or could not be dispatched.", "error"); }
        return;
      }
      if (parts[0] === "l1" && parts.length === 2 && ["off", "observe", "enforce"].includes(parts[1])) {
        if (!config) { ctx.ui.notify("Fix the JEV_* environment variables and reload first.", "error"); return; }
        revoke();
        config = { ...config, l1Mode: parts[1] as L1Mode };
        ctx.ui.notify(`Jev L1 mode: ${config.l1Mode}; scoped task authorization cleared.`, "info");
        return;
      }
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
        revoke();
        status(ctx);
        ctx.ui.notify(`Jev mode: ${next}`, next === "shadow" ? "warning" : "info");
        return;
      }
      if (args.trim() && args.trim() !== "status") {
        ctx.ui.notify("Usage: /jev [status] | /jev mode auto|manual|shadow | /jev l1 off|observe|enforce | /jev read-task <directory> -- <task>", "warning");
        return;
      }
      ctx.ui.notify(JSON.stringify({
        mode: config?.mode ?? "invalid", model: config?.model, configured: Boolean(config?.apiKey),
        l1Mode: config?.l1Mode, readTaskAuthorized: Boolean(grant?.phase === "bound"), layers,
        thresholds: config && { probability: config.probabilityThreshold, confidence: config.confidenceThreshold },
        stats: { ...stats, meanReviewMs: stats.calls ? Math.round(stats.totalMs / stats.calls) : 0 },
        last,
      }, null, 2), "info");
    },
  });
}

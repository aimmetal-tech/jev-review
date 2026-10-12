import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { LLM_POLICY, parseLLMDecision } from "../../src/llm.ts";
import { parseVerdict, readConfig } from "../../src/reviewer.ts";
import { assertCloud, parseEvents, redact, requestAllowed, type Event, type Role } from "./core.ts";

export function emit(event: Omit<Event, "case">): void {
  const path = process.env.LIVE_EVENT_FILE;
  if (!path) throw new Error("LIVE_EVENT_FILE_MISSING");
  appendFileSync(path, redact(JSON.stringify({ ...event, case: process.env.LIVE_CASE ?? "preflight" }),
    [process.env.LLM_API_KEY??"",process.env.TYPESAFE_API_KEY??"",process.env.LLM_BASE_URL??""]) + "\n", { mode: 0o600 });
}
export function events(): Event[] {
  try { return parseEvents(readFileSync(process.env.LIVE_EVENT_FILE!, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function tokens(value: unknown): number | null { return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null; }
export function installObserver(): typeof fetch {
  assertCloud(process.env);
  const marker=Symbol.for("jev-review.live-observer");
  const globals=globalThis as typeof globalThis & Record<symbol,typeof fetch>;
  if(globals[marker]){globalThis.fetch=globals[marker];return globals[marker];}
  const original = globalThis.fetch;
  const base = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !process.env.LLM_API_KEY || !process.env.TYPESAFE_API_KEY) throw new Error("LIVE_CREDENTIALS_MISSING");
  readConfig(process.env); // Validate HTTPS endpoint, model and shared configuration before any request.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${base}/chat/completions` && url !== "https://api.typesafe.ai/v1/systemone") {
      // No provider discovery, telemetry or third-party egress from these test processes.
      throw new Error("LIVE_ENDPOINT_NOT_ALLOWED");
    }
    const bodyText=typeof init?.body==="string"?init.body:input instanceof Request?await input.clone().text():undefined;
    if (!bodyText) throw new Error("LIVE_REQUEST_NOT_OBSERVABLE");
    const body = JSON.parse(bodyText);
    const role: Role = url.includes("api.typesafe.ai") ? "jev" : body.messages?.[0]?.content === LLM_POLICY ? "llm" : "main";
    const id = randomUUID(), caseId = process.env.LIVE_CASE ?? "preflight";
    if (!requestAllowed(events(), caseId, role)) { emit({type:"limit",role}); throw new Error("LIVE_REQUEST_LIMIT"); }
    // Never allow credentials in model-visible content, including accidental tool-result leakage.
    if ([process.env.LLM_API_KEY!, process.env.TYPESAFE_API_KEY!].some(secret => bodyText.includes(secret))) {
      emit({type:"guard",role,leak:true}); throw new Error("LIVE_SECRET_IN_REQUEST");
    }
    const injected = caseId === "jev-failure" && role === "jev";
    emit({type:"request",role,id,real:!injected});
    if (injected) { emit({type:"response",role,id,real:false,status:503,durationMs:0}); return new Response("Injected Jev failure",{status:503}); }
    const started = Date.now();
    try {
      const response = await original(input, {...init, redirect:"error"});
      const copy = response.clone();
      void (async () => {
        const event: Omit<Event,"case"> = {type:"response",role,id,real:true,status:response.status,inputTokens:null,outputTokens:null};
        try {
          const reader=copy.body?.getReader(); let text="";
          if (reader) while (true) { const chunk=await reader.read(); if(chunk.done)break;
            text+=Buffer.from(chunk.value).toString("utf8"); if(text.length>1048576){await reader.cancel();throw new Error("response cap");} }
          let value:any;
          if (copy.headers.get("content-type")?.includes("text/event-stream")) {
            for(const line of text.split("\n")) if(line.startsWith("data: ") && line.slice(6).trim()!=="[DONE]") {
              try { const item=JSON.parse(line.slice(6));if(item.usage)value=item; } catch { /* Non-usage SSE data is not retained. */ }
            }
          } else if(response.ok) value=JSON.parse(text);
          const usage=value?.usage;
          event.inputTokens=tokens(usage?.prompt_tokens??usage?.input_tokens);
          event.outputTokens=tokens(usage?.completion_tokens??usage?.output_tokens);
          if(response.ok&&role==="llm")event.decision=parseLLMDecision(value).decision;
          if(response.ok&&role==="jev") {
            const verdict=parseVerdict(value,readConfig(process.env));event.decision=verdict.decision;
            event.authorization=value.answers?.authorization?.choice;event.risk=value.answers?.risk?.choice;
          }
        } catch { /* Keep status and unknown usage, never provider prose. */ }
        event.durationMs=Date.now()-started;emit(event);
      })();
      return response;
    } catch { emit({type:"response",role,id,real:true,status:0,durationMs:Date.now()-started});throw new Error("LIVE_TRANSPORT_FAILED"); }
  };
  globals[marker]=globalThis.fetch;
  return globals[marker];
}

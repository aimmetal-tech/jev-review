import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Model } from "@earendil-works/pi-ai";
import { emit, events, installObserver } from "./observer.ts";
import { inspectResult } from "./core.ts";

export default function control(pi: ExtensionAPI): void {
  installObserver();
  // The CLI can retain a transport before extensions initialize. Supply the observer
  // explicitly to the stock OpenAI transport instead of relying on ambient fetch.
  pi.registerProvider("jev-live",{api:"openai-completions",baseUrl:process.env.LLM_BASE_URL,apiKey:"$LLM_API_KEY",
    models:[{id:"mimo-v2.6-flash",name:"MiMo live test",reasoning:true,input:["text"],contextWindow:32768,maxTokens:2048,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{thinkingFormat:"deepseek"}}],
    streamSimple:(model,context,options)=>streamSimple(model as Model<"openai-completions">,context,
      {...options,apiKey:process.env.LLM_API_KEY,fetch:globalThis.fetch,maxRetries:0,maxTokens:2048,reasoning:undefined}),
  });
  pi.on("tool_call", event => {
    emit({type:"tool",tool:event.toolName});
    if(events().filter(e=>e.case===process.env.LIVE_CASE&&e.type==="tool").length>10) {
      emit({type:"limit"});return {block:true,reason:"LIVE_TOOL_LIMIT"};
    }
    if(!["read","write","bash"].includes(event.toolName))return {block:true,reason:"LIVE_TOOL_NOT_ALLOWED"};
    return undefined;
  });
  pi.on("tool_result", event => {
    const text=event.content.filter(block=>block.type==="text").map(block=>block.type==="text"?block.text:"").join("\n");
    emit({type:"result",tool:event.toolName,ok:!event.isError,...inspectResult(text,process.env.LIVE_READ_NONCE??"",process.env.LIVE_CANARY??"",
      [process.env.LLM_API_KEY??"",process.env.TYPESAFE_API_KEY??""])});
  });
}

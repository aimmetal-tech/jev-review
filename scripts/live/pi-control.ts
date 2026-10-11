import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emit, events } from "./observer.ts";
import { inspectResult } from "./core.ts";

export default function control(pi: ExtensionAPI): void {
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

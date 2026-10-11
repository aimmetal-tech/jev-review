import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-agent";
import { AUTO_PRESET } from "@deepseek-ai/dsh-permission-presets";
import { emit, events, installObserver } from "./observer.ts";
import { inspectResult } from "./core.ts";

export const name="live-test-control";
export function apply(ctx: Context): void {
  installObserver();
  const tools=["jev_read","jev_write","jev_bash"];
  ctx.inject(["tools","permissionPresets"],scope=>{
    scope.on("agent/created",async({agent})=>{
      scope.permissionPresets.set(agent.session,AUTO_PRESET);
      await agent.ctx.inject(["tools"],owner=>{owner.tools.restrict({allow:tools});});
    });
    scope.on("tools/pre-execute",async(exec,next)=>{
      emit({type:"tool",tool:exec.name});
      if(events().filter(e=>e.case===process.env.LIVE_CASE&&e.type==="tool").length>10){emit({type:"limit"});return {kind:"deny",reason:"LIVE_TOOL_LIMIT"};}
      if(!tools.includes(exec.name))return {kind:"deny",reason:"LIVE_TOOL_NOT_ALLOWED"};
      return next();
    },{prepend:true});
    scope.tools.guard(exec=>tools.includes(exec.name)?undefined:"LIVE_TOOL_NOT_ALLOWED");
    scope.on("tools/result",(exec,result)=>{
      const text=result.content.filter(block=>block.type==="text").map(block=>block.type==="text"?block.text:"").join("\n");
      emit({type:"result",tool:exec.name,ok:!result.isError,...inspectResult(text,process.env.LIVE_READ_NONCE??"",process.env.LIVE_CANARY??"",
        [process.env.LLM_API_KEY??"",process.env.TYPESAFE_API_KEY??""])});
      return undefined;
    });
  });
  ctx.on("approval/request",async()=>{emit({type:"approval"});return "rejected";},{prepend:true});
}

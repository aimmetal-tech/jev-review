import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-llm";
import { AUTO_PRESET } from "@deepseek-ai/dsh-permission-presets";
import { emit, events, installObserver } from "./observer.ts";
import { inspectResult } from "./core.ts";

export const name="live-test-control";
export function bindFixtureTask(ctx:Context,sessionId:string,task:string,taskId:string):void {
  let bound=false;
  ctx.on("agent/created",({agent})=>{
    if(String(agent.session.id)!==sessionId)return undefined;
    const followup=agent.followup;
    agent.followup=function(message){
      // Normalize only the exact trusted driver input before it enters the inbox;
      // preserve its ID so the SDK receipt still refers to the same message.
      const matches=!bound&&message.source.kind==="user"&&!("rpcId" in message.source)&&message.content.length===1&&
        message.content[0].type==="text"&&message.content[0].text===task;
      if(matches){bound=true;emit({type:"guard",id:"driver-task-bound"});
        const authorized={...message,source:{kind:"user" as const,rpcId:taskId}};
        return followup.call(agent,authorized);}
      return followup.call(agent,message);
    };
    agent.ctx.effect(()=>()=>{agent.followup=followup;});
    return undefined;
  });
}
export function apply(ctx: Context): void {
  const observedFetch=installObserver();
  ctx.on("llm/stream",async function*(_options,next){
    globalThis.fetch=observedFetch;
    yield* next();
  },{prepend:true});
  const tools=["jev_read","jev_write","jev_bash"];
  if(process.env.LIVE_AUTH_SESSION&&process.env.LIVE_AUTH_TASK&&process.env.LIVE_AUTH_ID)
    bindFixtureTask(ctx,process.env.LIVE_AUTH_SESSION,process.env.LIVE_AUTH_TASK,process.env.LIVE_AUTH_ID);
  ctx.inject(["tools","permissionPresets"],scope=>{
    scope.on("agent/created",async({agent})=>{
      scope.permissionPresets.set(agent.session,AUTO_PRESET);
      await agent.ctx.inject(["tools"],owner=>{owner.tools.restrict({allow:tools});});
    });
    scope.on("tools/pre-execute",async(exec,next)=>{
      globalThis.fetch=observedFetch;
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

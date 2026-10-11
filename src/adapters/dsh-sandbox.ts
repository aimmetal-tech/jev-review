import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolExecution, PreToolDecision } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-working-directory";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type { Verdict, Config, Operation } from "../reviewer.ts";
import { DockerSandbox, sandboxSchema, type SandboxPlan } from "../sandbox.ts";
import { RecoveryBudget } from "../recovery.ts";

export interface DshReviewFrame { exec:ToolExecution; plan?:SandboxPlan; definition?:ToolDefinition; verdict?:Verdict; approved:boolean; humanEligible:boolean; signature?:string }
export interface DshExecution { frames:AsyncLocalStorage<DshReviewFrame>; sandbox:DockerSandbox }
const bases:Record<string,Record<string,unknown>>={
  read:{path:{type:"string"},offset:{type:"integer",minimum:1},limit:{type:"integer",minimum:1}},
  write:{path:{type:"string"},content:{type:"string"}},
  edit:{path:{type:"string"},edits:{type:"array",items:{type:"object",properties:{oldText:{type:"string"},newText:{type:"string"}},required:["oldText","newText"]}}},
  bash:{command:{type:"string"}},run_code:{code:{type:"string"}},ls:{path:{type:"string"}},find:{path:{type:"string"},pattern:{type:"string"}},grep:{path:{type:"string"},pattern:{type:"string"}},
};

/** Only our registered bodies establish confinement; same-name custom tools are never proof. */
export function attachDshExecution(ctx:Context, config:Config):DshExecution {
  const sandbox=new DockerSandbox(config.sandbox),frames=new AsyncLocalStorage<DshReviewFrame>();
  const entries=new Map<symbol,DshReviewFrame>(),definitions=new Map<string,ToolDefinition>();
  const budgets=new Map<string,{signature?:string;budget:RecoveryBudget}>(),presentation=new Map<object,()=>void|Promise<void>>();
  const boundAgents=new WeakSet<object>();
  ctx.inject(["tools"],scope=>{
    if(config.sandbox.mode!=="off")for(const [kind,properties]of Object.entries(bases)) {
      const name=kind==="run_code"?"jev_code":`jev_${kind}`;
      const definition:ToolDefinition={name,description:`Jev Docker sandbox ${kind}. File paths are host paths; commands/code execute under /workspace. `+
        "Prefer this confined tool. Request only needed read_roots/writable_roots or network_access with justification when existing permissions are insufficient.",
        parameters:sandboxSchema({type:"object",properties}),
        output:{schema:{type:"string"},render:(_args,value)=>[{type:"text",text:String(value)}]},
        async execute(args,exec) {
          const entry=entries.get(exec.token);
          if(!entry?.plan||entry.definition!==definition)throw new Error("Sandbox execution binding is missing");
          if(!args||typeof args!=="object"||Array.isArray(args))throw new Error("Invalid sandbox arguments");
          const operation={...entry.plan.operation,input:args as Record<string,unknown>};
          const result=await sandbox.execute(entry.plan,operation,entry.approved,exec.signal);
          if(result.isError)throw new Error(result.text||"Sandbox command failed");return result.text;
        }};
      definitions.set(name,definition);scope.tools.register(definition);
    }
    const gate=async(exec:ToolExecution,next:()=>Promise<PreToolDecision>):Promise<PreToolDecision>=>{
      if(!exec.agent)return next();
      if(config.sandbox.mode!=="off"&&exec.name==="run_code")return {kind:"deny",reason:"Host PTC execution is disabled while the sandbox is active. Use jev_code for confined Node execution, or native jev_* tools."};
      const entry:DshReviewFrame={exec,approved:false,humanEligible:false};entries.set(exec.token,entry);
      const definition=definitions.get(exec.name);
      if(definition&&scope.tools.get(exec.name,exec.agent)===definition) {
        try {
          if(!exec.arguments||typeof exec.arguments!=="object"||Array.isArray(exec.arguments))throw new Error("Invalid arguments");
          const cwd=await scope.workingDirectory.ensure(exec.agent,exec.signal);
          const kind=exec.name==="jev_code"?"run_code":exec.name.slice(4);
          const operation:Operation={tool:kind,input:exec.arguments as Record<string,unknown>,cwd,source:"agent",description:definition.description};
          let readOnly=false;try{readOnly=scope.permissionPresets.current(exec.agent.session)==="read-only";}catch{/* Deployment standing mode applies without a preset service. */}
          entry.plan=await sandbox.prepare(operation,readOnly,exec.agent.session.header.cwd??cwd);entry.definition=definition;
        }catch{entries.delete(exec.token);return {kind:"deny",reason:"Sandbox is unavailable or the requested paths cannot be safely mounted; the operation was not executed."};}
      }
      const result=await frames.run(entry,next);
      if(exec.signal.aborted)return {kind:"cancel"};
      if(entry.verdict) {
        const key=String(exec.agent.session.id);let record=budgets.get(key);
        if(!record||record.signature!==entry.signature){record={signature:entry.signature,budget:new RecoveryBudget()};budgets.set(key,record);}
        const response=record.budget.outcome(entry.verdict,config.humanAfter);
        if(entry.verdict.decision==="allow")entry.approved=true;
        else if(entry.verdict.decision==="deny"||(!response.human&&config.mode!=="manual")) {
          entries.delete(exec.token);return {kind:"deny",reason:`Auto review: ${response.reason}`};
        }else entry.humanEligible=true;
      }
      if(entry.plan&&!entry.approved&&!entry.humanEligible) {
        if(sandbox.canRun(entry.plan,entry.plan.operation))entry.approved=true;
        else{entries.delete(exec.token);return {kind:"deny",reason:"This call crosses the standing sandbox boundary. Enable the session's Auto review policy to review this exact exception."};}
      }
      if(result.kind!=="allow"&&result.kind!=="ask")entries.delete(exec.token);
      return result;
    };
    // Native Auto can activate after our global hook while the complete application
    // boots. Bind an outer gate at agent creation, after global plugins are ready.
    scope.on("tools/pre-execute",(exec,next)=>exec.agent&&boundAgents.has(exec.agent)?next():gate(exec,next),{prepend:true});
    scope.on("agent/created",async({agent})=>{
      const fiber=agent.ctx.inject(["tools"],owner=>{
        if(config.sandbox.mode!=="off")owner.tools.presentAs("native");
        owner.on("tools/pre-execute",gate,{prepend:true});
      });
      await fiber;boundAgents.add(agent);
      presentation.set(agent,()=>fiber.dispose());
    });
    scope.tools.guard(exec=>{
      const entry=entries.get(exec.token);
      if(entry?.definition&&scope.tools.get(exec.name,exec.agent)!==entry.definition)return "Sandbox executor binding changed";
      return undefined;
    });
    scope.on("approval/request",async(request,next)=>{
      const outcome=await next();
      if(outcome==="allowed-once")for(const entry of entries.values())if(entry.humanEligible&&entry.exec.callId===request.callId&&entry.exec.agent===request.agent){entry.approved=true;budgets.get(String(request.agent.session.id))?.budget.reset();}
      return outcome;
    },{prepend:true});
    scope.on("tools/result",exec=>{entries.delete(exec.token);return undefined;});
    scope.on("agent/disposed",({agent})=>{boundAgents.delete(agent);budgets.delete(String(agent.session.id));void presentation.get(agent)?.();presentation.delete(agent);});
  });
  ctx.effect(()=>async()=>{for(const dispose of presentation.values())await dispose();presentation.clear();await sandbox.dispose();});
  return {frames,sandbox};
}

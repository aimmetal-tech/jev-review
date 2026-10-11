import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime,{createMessage,createUserMessage,ToolCallId} from "@deepseek-ai/dsh-llm";
import SessionStore,{SessionId} from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import ApprovalService from "@deepseek-ai/dsh-user-approval";
import WorkingDirectoryService from "@deepseek-ai/dsh-working-directory";
import PermissionPresetService,{AUTO_PRESET} from "@deepseek-ai/dsh-permission-presets";
import * as NativeAutoReview from "@deepseek-ai/dsh-experimental-auto-review";
import type {Agent} from "@deepseek-ai/dsh-agent";
import {createScope,scopeTarget} from "@deepseek-ai/dsh-scope";
import piReview from "../src/adapters/pi.ts";
import * as DshReview from "../src/adapters/dsh.ts";
import { QUESTIONS } from "../src/reviewer.ts";
import { DockerSandbox, type SandboxPlan } from "../src/sandbox.ts";
import { bindFixtureTask } from "../scripts/live/dsh-control.ts";

function jev(risk="routine"){const choice=(value:string,keys:string[])=>({type:"choice",choice:value,confidence:1,probabilities:Object.fromEntries(keys.map(key=>[key,Number(key===value)]))});
  return Response.json({model:"jev-1.13.0",answers:{authorization:choice("authorized",Object.keys(QUESTIONS.authorization.criteria)),risk:choice(risk,Object.keys(QUESTIONS.risk.criteria))}});}
function llm(){return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({decision:"allow",authorization:"authorized",risk:"sensitive",reason:"explicit bounded request",saferAlternative:null})}}]});}
const live=process.env.JEV_TEST_DOCKER==="1";
const image=process.env.JEV_TEST_IMAGE??"public.ecr.aws/docker/library/node:24-alpine";

test("late native Auto activation cannot precede an agent's owned execution frame (simulated backend)",async t=>{
  const cwd="/fixture-app";
  const diagnostic=await mkdtemp(join(tmpdir(),"sdk-authority-simulation-"));t.after(()=>rm(diagnostic,{recursive:true,force:true}));
  const savedEvents=process.env.LIVE_EVENT_FILE;process.env.LIVE_EVENT_FILE=join(diagnostic,"events.jsonl");
  t.after(()=>{if(savedEvents===undefined)delete process.env.LIVE_EVENT_FILE;else process.env.LIVE_EVENT_FILE=savedEvents;});
  t.mock.method(DockerSandbox.prototype,"prepare",async(operation:any)=>({operation,digest:"simulation",root:cwd,
    action:{kind:"read",args:{path:operation.input.path}},mounts:[],requiresReview:false,network:false,writable:false,cwdTarget:cwd}) as SandboxPlan);
  t.mock.method(DockerSandbox.prototype,"canRun",()=>true);
  t.mock.method(DockerSandbox.prototype,"execute",async()=>({text:"simulated confined result",isError:false}));
  t.mock.method(DockerSandbox.prototype,"dispose",async()=>{});
  t.mock.method(globalThis,"fetch",async()=>{assert.fail("Standing managed operation must not call a model");});
  const ctx=new Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  // Matches full application boot: adapter is present before Auto's dependencies.
  await ctx.plugin(DshReview,{apiKeyEnv:"JEV_SIM_MISSING_KEY",llmApiKeyEnv:"JEV_SIM_MISSING_LLM"});
  await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime,{mode:"ptc"});
  ctx.provide("shell",{sandboxMode:"workspace-write",resolve(){throw new Error("unused");},execute(){throw new Error("unused");}});
  ctx.provide("fs",{resolve:async(path:string)=>({path}),stat:async()=>({type:"directory"}),processPath:(target:any)=>target.path});
  await ctx.plugin(WorkingDirectoryService,{defaultDirectory:cwd});
  await ctx.plugin(ApprovalService,{policy:"ask"});
  await ctx.plugin(PermissionPresetService,{presets:{"workspace-write":{sandbox:"workspace-write",approval:"ask"}},defaultPreset:"workspace-write"});
  await ctx.plugin(NativeAutoReview);
  const session=ctx.sessions.create(SessionId("late-auto-simulation"),{meta:{cwd}});ctx.permissionPresets.set(session,AUTO_PRESET);
  bindFixtureTask(ctx,String(session.id),"Read note.txt","fixture-human-source");
  const agent={id:session.id,session,options:{provider:"fixture",model:"fixture"},
    followup:(message:any)=>{session.append("user/message",message,{surfaceOp:"append"});}} as Agent;
  const scope=createScope(ctx,agent);Object.assign(agent,{ctx:scope.ctx});t.after(()=>scope.dispose());
  await ctx.serial(scopeTarget(agent,agent),"agent/created",{agent,source:"startup"});
  session.append("request/header",{header:{config:{provider:"fixture",model:"fixture"},tools:ctx.tools.schemas(agent)},reason:"initial"});
  agent.followup(createUserMessage({content:[{type:"text",text:"Read note.txt"}],source:{kind:"user"}}));
  session.append("turn/start",{turn:1});session.append("step/start",{turn:1,step:1});
  const id=ToolCallId("late-read"),args={path:"note.txt"},raw=JSON.stringify(args);
  session.append("assistant/message",{turn:1,step:1,stream:[],message:createMessage({role:"assistant",content:[{type:"tool-call",id,name:"jev_read",arguments:raw}],source:{kind:"model",provider:"fixture",model:"fixture"}})},{surfaceOp:"append"});
  session.append("tool/call",{turn:1,step:1,callId:id,name:"jev_read",arguments:raw});
  let nativeRequests:string[]|undefined;
  ctx.on("llm/stream",(options,next)=>{if(options.system?.startsWith("REVIEW_POLICY\n"))nativeRequests=DshReview.translateReviewInput(options).userRequests;return next();},{prepend:true});
  const result=await ctx.tools.execute({callId:id,name:"jev_read",arguments:args,agent,signal:new AbortController().signal});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.content[0].type==="text"&&result.content[0].text,"simulated confined result");
  assert.deepEqual(nativeRequests,["Read note.txt"],"native Auto must retain only the exact driver's fixture input as human provenance");
});

test("live Pi routes ordinary owned tools through Docker and uses Jev then LLM only for exceptions",{skip:!live},async t=>{
  const cwd=await mkdtemp(join(tmpdir(),"pi-execution-")),outside=await mkdtemp(join(tmpdir(),"pi-exception-"));
  t.after(()=>rm(cwd,{recursive:true,force:true}));t.after(()=>rm(outside,{recursive:true,force:true}));
  await mkdir(join(cwd,"docs"));await writeFile(join(cwd,"docs/note.md"),"within sandbox");
  const envNames=[...Object.keys(process.env).filter(key=>key.startsWith("JEV_")),"TYPESAFE_API_KEY","LLM_API_KEY","LLM_BASE_URL"];
  const previous=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));for(const name of envNames)delete process.env[name];
  Object.assign(process.env,{JEV_SANDBOX_IMAGE:image,TYPESAFE_API_KEY:"mock-jev-key",LLM_API_KEY:"mock-llm-key"});
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const handlers=new Map<string,any>(),definitions=new Map<string,any>(),notifications:string[]=[];
  const tools:any[]=[{name:"read",description:"read text",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]},sourceInfo:{source:"builtin",path:"builtin:read"}},
    {name:"write",description:"write text",parameters:{type:"object",properties:{path:{type:"string"},content:{type:"string"}},required:["path","content"]},sourceInfo:{source:"builtin",path:"builtin:write"}}];
  let human=0;
  const ctx:any={cwd,signal:undefined,hasUI:true,ui:{setStatus(){},notify(text:string){notifications.push(text);},async confirm(){human++;return false;}},
    sessionManager:{getSessionId:()=>"live-pi",getCwd:()=>cwd,getBranch:()=>[{id:"user",type:"message",message:{role:"user",content:`Read project files and write exactly ${join(outside,"one.md")}`}}]}};
  const api:any={on(name:string,handler:any){handlers.set(name,handler);},registerCommand(){},getAllTools:()=>tools,
    registerTool(definition:any){definitions.set(definition.name,definition);const index=tools.findIndex(tool=>tool.name===definition.name);tools[index]={...definition,sourceInfo:{source:"extension",path:"jev-pi-adapter"}};}};
  piReview(api as ExtensionAPI);await handlers.get("session_start")({},ctx);
  const requests:string[]=[];
  t.mock.method(globalThis,"fetch",async(url:unknown)=>{requests.push(String(url));return String(url).includes("typesafe")?jev("sensitive"):llm();});
  const readArgs={path:"docs/note.md"};
  assert.equal(await handlers.get("tool_call")({toolName:"read",toolCallId:"read-1",input:readArgs},ctx),undefined);
  const read=await definitions.get("read").execute("read-1",readArgs,undefined,undefined,ctx);
  assert.equal(read.content[0].text,"within sandbox");assert.equal(requests.length,0);assert.equal(human,0);
  const args={path:join(outside,"one.md"),content:"one approved exception"};
  assert.equal(await handlers.get("tool_call")({toolName:"write",toolCallId:"write-1",input:args},ctx),undefined);
  await definitions.get("write").execute("write-1",args,undefined,undefined,ctx);
  assert.equal(await readFile(args.path,"utf8"),args.content);
  assert.equal(requests.length,2);assert.ok(requests[0].includes("typesafe"));assert.ok(requests[1].includes("chat/completions"));assert.equal(human,0);
  await assert.rejects(definitions.get("write").execute("write-1",args,undefined,undefined,ctx),/binding expired/);
  await handlers.get("session_shutdown")({},ctx);
});

test("live DSH sandbox tools retain native execution, binding and two-model boundary review",{skip:!live},async t=>{
  const cwd=await mkdtemp(join(tmpdir(),"dsh-execution-")),outside=await mkdtemp(join(tmpdir(),"dsh-exception-"));
  t.after(()=>rm(cwd,{recursive:true,force:true}));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(cwd,"note.md"),"native sandbox read");
  const ctx=new Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime,{mode:"ptc"});
  ctx.provide("shell",{sandboxMode:"workspace-write",resolve(){throw new Error("Shell stub is not used by owned sandbox tools");},execute(){throw new Error("Shell stub is not used by owned sandbox tools");}});
  ctx.provide("workingDirectory",{ensure:async()=>cwd});
  await ctx.plugin(ApprovalService,{policy:"ask"});await ctx.plugin(PermissionPresetService,{presets:{"workspace-write":{sandbox:"workspace-write",approval:"ask",name:"Workspace"}},defaultPreset:"workspace-write"});
  await ctx.plugin(NativeAutoReview);
  const previous={jev:process.env.JEV_EXEC_JEV_KEY,llm:process.env.JEV_EXEC_LLM_KEY};Object.assign(process.env,{JEV_EXEC_JEV_KEY:"mock-jev-key",JEV_EXEC_LLM_KEY:"mock-llm-key"});
  t.after(()=>{for(const [key,value]of Object.entries({JEV_EXEC_JEV_KEY:previous.jev,JEV_EXEC_LLM_KEY:previous.llm})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  await ctx.plugin(DshReview,{apiKeyEnv:"JEV_EXEC_JEV_KEY",llmApiKeyEnv:"JEV_EXEC_LLM_KEY",sandboxImage:image});
  const session=ctx.sessions.create(SessionId("dsh-sandbox-live"),{meta:{cwd}});
  ctx.permissionPresets.set(session,AUTO_PRESET);
  const agent={id:session.id,session,options:{provider:"main-provider",model:"main-model"}} as Agent;
  const scope=createScope(ctx,agent);t.after(()=>scope.dispose());
  Object.assign(agent,{ctx:scope.ctx});await ctx.serial(scopeTarget(agent,agent),"agent/created",{agent,source:"startup"});
  assert.equal(ctx.tools.schemas(agent).some(schema=>schema.name==="run_code"),false,"Host PTC must not be presented instead of confined tools");
  session.append("request/header",{header:{config:{provider:"main-provider",model:"main-model"},tools:ctx.tools.schemas(agent)},reason:"initial"});
  session.append("user/message",createUserMessage({content:[{type:"text",text:`Read files and write exactly ${join(outside,"one.md")}`}],source:{kind:"user",rpcId:"fixture"}}),{surfaceOp:"append"});
  session.append("turn/start",{turn:1});
  const requests:string[]=[];let humans=0;
  ctx.on("approval/request",async()=>{humans++;return "rejected";});
  t.mock.method(globalThis,"fetch",async(url:unknown)=>{requests.push(String(url));return String(url).includes("typesafe")?jev("sensitive"):llm();});
  let step=0;
  async function call(name:string,args:Record<string,unknown>){const next=++step,id=ToolCallId(`call-${next}`),raw=JSON.stringify(args);
    session.append("step/start",{turn:1,step:next});session.append("assistant/message",{turn:1,step:next,stream:[],message:createMessage({role:"assistant",content:[{type:"tool-call",id,name,arguments:raw}],source:{kind:"model",provider:"main-provider",model:"main-model"}})},{surfaceOp:"append"});
    session.append("tool/call",{turn:1,step:next,callId:id,name,arguments:raw});
    return ctx.tools.execute({callId:id,name,arguments:args,agent,signal:new AbortController().signal});}
  const read=await call("jev_read",{path:"note.md"});
  assert.equal(read.isError,false,JSON.stringify(read));assert.equal(read.content[0].type==="text"&&read.content[0].text,"native sandbox read");assert.equal(requests.length,0);assert.equal(humans,0);
  const written=await call("jev_write",{path:join(outside,"one.md"),content:"scoped native exception"});
  assert.equal(written.isError,false,JSON.stringify(written));assert.equal(await readFile(join(outside,"one.md"),"utf8"),"scoped native exception");
  assert.equal(requests.length,2);assert.equal(humans,0);
});

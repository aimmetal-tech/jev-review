import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installObserver } from "../scripts/live/observer.ts";
import { LLM_POLICY } from "../src/llm.ts";
import { assertCloud, evaluate, hasProbeCall, inspectResult, parseEvents, redact, requestAllowed, type Event, type Evidence } from "../scripts/live/core.ts";

const main:Event={type:"response",case:"read",role:"main",status:200,real:true};
const evidence=(extra:Partial<Evidence>={}):Evidence=>({id:"read",events:[main,{type:"result",case:"read",ok:true,readMatch:true}],
  targetWritten:false,unexpectedChanges:false,cleanup:true,completed:true,...extra});
test("live runner refuses local execution and non-manual jobs before API access",()=>{
  assert.throws(()=>assertCloud({}),/LIVE_CLOUD_ONLY/);
  const env={GITHUB_ACTIONS:"true",RUNNER_ENVIRONMENT:"github-hosted",RUNNER_OS:"Linux",RUNNER_TEMP:"/tmp/run",GITHUB_EVENT_NAME:"workflow_dispatch"};
  assert.doesNotThrow(()=>assertCloud(env));
  for(const change of [{RUNNER_ENVIRONMENT:"self-hosted"},{GITHUB_EVENT_NAME:"push"},{RUNNER_OS:"Windows"}])assert.throws(()=>assertCloud({...env,...change}));
});
test("request budget includes retries and injected attempts across cases",()=>{
  const six=Array.from({length:6},()=>({type:"request",case:"read",role:"main",real:true}) as Event);
  assert.equal(requestAllowed(six,"read","main"),false);
  assert.equal(requestAllowed(six,"write","main"),true);
  const sixty=Array.from({length:60},()=>({type:"request",case:"jev-failure",role:"jev",real:false}) as Event);
  assert.equal(requestAllowed(sixty,"read","main"),false);
  assert.equal(requestAllowed(sixty,"outside","llm"),false);
});
test("standing coverage requires real model and actual successful tool result",()=>{
  assert.equal(evaluate(evidence()).status,"pass");
  assert.equal(evaluate(evidence({events:[main]})).status,"uncovered");
  assert.equal(evaluate(evidence({events:[]})).status,"uncovered");
  assert.equal(evaluate(evidence({events:[main,{type:"request",case:"read",role:"jev",real:true}]})).status,"fail");
  assert.equal(evaluate(evidence({events:[{...main,real:false}]})).status,"uncovered");
});
test("side effects, limits, unfinished hosts and cleanup failures cannot pass",()=>{
  for(const extra of [{cleanup:false},{unexpectedChanges:true},{completed:false}])assert.equal(evaluate(evidence(extra)).status,"fail");
  for(const event of [{type:"limit",case:"read"},{type:"result",case:"read",leak:true}] as Event[])assert.equal(evaluate(evidence({events:[main,event]})).status,"fail");
});
test("fault injection is separate from genuine final review approval",()=>{
  const events:Event[]=[{...main,case:"jev-failure"},{type:"tool",case:"jev-failure",tool:"write"},
    {type:"request",case:"jev-failure",role:"jev",real:false},
    {type:"response",case:"jev-failure",role:"llm",status:200,real:true,decision:"allow"}];
  const input=evidence({id:"jev-failure",events,targetWritten:true});
  assert.equal(evaluate(input).status,"pass");
  assert.equal(evaluate({...input,events:events.filter(e=>e.type!=="request")}).status,"uncovered");
  assert.equal(evaluate({...input,events:events.map(e=>e.role==="llm"?{...e,real:false}:e)}).status,"uncovered");
  assert.equal(evaluate({...input,events:events.map(e=>e.role==="llm"?{...e,decision:"deny"}:e)}).status,"fail");
});
test("injection prevented by main agent is not attributed to Jev",()=>{
  const input=evidence({id:"injection",events:[{...main,case:"injection"},{type:"result",case:"injection",readMatch:true,ok:true}]});
  assert.equal(evaluate(input).refusalLayer,"main_agent");
  assert.equal(evaluate({...input,targetWritten:true}).status,"fail");
});
test("report sanitization removes secrets and retains only detection flags",()=>{
  const inspected=inspectResult("nonce\nsecret-key", "nonce", "canary",["secret-key"]);
  assert.deepEqual(inspected,{readMatch:true,canaryProbe:false,canaryProbeFailed:false,leak:true});
  assert.equal(evaluate(evidence({id:"canary",events:[{...main,case:"canary"},{type:"result",case:"canary",ok:true,canaryProbeFailed:true}]})).status,"fail");
  assert.equal(redact("secret-key https://private/v1",["secret-key","https://private/v1"]),"[REDACTED] [REDACTED]");
  assert.deepEqual(parseEvents('{"type":"request","case":"read","real":true}\n'),[{type:"request",case:"read",real:true}]);
});
test("compatibility probe requires streamed tool name and exact empty arguments",()=>{
  const chunk=(name:string,args:string)=>`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{name,arguments:args}}]}}]})}\n`;
  assert.equal(hasProbeCall(chunk("pro","{")+chunk("be","}")+"data: [DONE]\n"),true);
  assert.equal(hasProbeCall(chunk("probe",'{"command":"unsafe"}')),false);
  assert.equal(hasProbeCall("data: not JSON\n"),false);
  assert.equal(hasProbeCall("data: {\"choices\":[{\"delta\":{\"content\":\"probe\"}}]}\n"),false);
});
test("observer forwards genuine-shaped requests, isolates injected faults and never stores provider prose",async t=>{
  const root=await mkdtemp(join(tmpdir(),"live-observer-mock-")),file=join(root,"events.jsonl");
  t.after(()=>rm(root,{recursive:true,force:true}));
  const values={GITHUB_ACTIONS:"true",RUNNER_ENVIRONMENT:"github-hosted",RUNNER_OS:"Linux",RUNNER_TEMP:root,GITHUB_EVENT_NAME:"workflow_dispatch",
    LIVE_EVENT_FILE:file,LIVE_CASE:"outside",LLM_API_KEY:"mock-live-key",TYPESAFE_API_KEY:"mock-jev-key",LLM_BASE_URL:"https://fixture.invalid/v1"};
  const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  t.after(()=>{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({
    decision:"allow",authorization:"authorized",risk:"routine",reason:"private-provider-prose",saferAlternative:null})}}],usage:{prompt_tokens:2,completion_tokens:1}});});
  installObserver();
  t.after(()=>{delete (globalThis as any)[Symbol.for("jev-review.live-observer")];});
  const observed=globalThis.fetch;installObserver();assert.equal(globalThis.fetch,observed,"observer installation must be idempotent");
  const {apply}=await import("../scripts/live/dsh-control.ts");
  const handlers=new Map<string,any>();let allow:readonly string[]=[];let guard:any;
  const scope:any={on:(event:string,fn:any)=>handlers.set(event,fn),permissionPresets:{set(){}},tools:{guard:(fn:any)=>{guard=fn;}}};
  apply({inject:(_services:any,fn:any)=>fn(scope),on:(event:string,fn:any)=>handlers.set(event,fn)} as any);
  await handlers.get("agent/created")({agent:{session:{},ctx:{inject:async(_services:any,fn:any)=>fn({tools:{
    restrict:(filter:any)=>{allow=filter.allow;},presentAs:()=>{throw new Error("presentation already selected by the real adapter");},
  }})}}});
  assert.deepEqual(allow,["jev_read","jev_write","jev_bash"]);
  assert.equal(guard({name:"run_code"}),"LIVE_TOOL_NOT_ALLOWED");
  assert.equal(guard({name:"jev_read"}),undefined);
  assert.equal(globalThis.fetch,observed,"control module must not double wrap fetch");
  const response=await fetch("https://fixture.invalid/v1/chat/completions",{method:"POST",body:JSON.stringify({messages:[{role:"system",content:LLM_POLICY}]})});
  await response.text();
  let recorded:Event[]=[];
  for(let attempt=0;attempt<100;attempt++){recorded=parseEvents(await readFile(file,"utf8"));if(recorded.some(e=>e.type==="response"))break;await new Promise<void>(done=>setTimeout(done,5));}
  assert.equal(recorded.find(e=>e.type==="response")?.decision,"allow");
  assert.equal(recorded.find(e=>e.type==="response")?.inputTokens,2);
  assert.equal(calls,1);
  const {default:piControl}=await import("../scripts/live/pi-control.ts");
  let provider:any;
  piControl({on(){},registerProvider:(_name:string,config:any)=>{provider=config;}} as any);
  const stream=provider.streamSimple({...provider.models[0],type:"chat",api:"openai-completions",provider:"jev-live",baseUrl:values.LLM_BASE_URL},
    {messages:[{role:"user",content:[{type:"text",text:"Mock transport check"}],timestamp:Date.now()}]},{});
  await stream.result(); // The mock deliberately returns JSON instead of SSE; no host or API is started.
  assert.equal(calls,2,"stock Pi transport must use the explicitly observed mock fetch");
  process.env.LIVE_CASE="jev-failure";
  assert.equal((await fetch("https://api.typesafe.ai/v1/systemone",{method:"POST",body:"{}"})).status,503);
  assert.equal(calls,2);
  await assert.rejects(fetch("https://elsewhere.invalid",{method:"POST",body:"{}"}),/ENDPOINT_NOT_ALLOWED/);
  await assert.rejects(fetch("https://fixture.invalid/v1/chat/completions",{method:"POST",body:JSON.stringify({messages:[{content:"mock-live-key"}]})}),/SECRET_IN_REQUEST/);
  const serialized=await readFile(file,"utf8");
  for(const secret of ["mock-live-key","mock-jev-key","private-provider-prose"])assert.equal(serialized.includes(secret),false);
  assert.equal(parseEvents(serialized).find(e=>e.type==="request"&&e.case==="jev-failure")?.real,false);
});

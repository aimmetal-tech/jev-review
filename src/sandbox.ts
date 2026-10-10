import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_WORKER } from "./sandbox-worker.ts";
import type { Operation } from "./reviewer.ts";

export interface SandboxConfig { mode: "off" | "read-only" | "workspace-write"; image: string; timeoutMs: number; dockerPath?: string }
export interface SandboxMount { source: string; target: string; write: boolean }
export interface SandboxAction { kind: "read" | "write" | "edit" | "ls" | "find" | "grep" | "shell" | "code"; args: Record<string, unknown> }
export interface SandboxPlan {
  operation: Operation; digest: string; root: string; action: SandboxAction; mounts: SandboxMount[];
  requiresReview: boolean; network: boolean; writable: boolean; hostTarget?: string; cwdTarget:string;
}
export interface SandboxResult { text: string; isError: boolean; exitCode?: number; truncated?: boolean }
export class SandboxUnavailableError extends Error { constructor() { super("SANDBOX_UNAVAILABLE: no verified Docker sandbox is available; execution was not performed."); } }
export const SANDBOX_TOOL_NAMES = ["read", "read_file", "write", "write_file", "edit", "edit_file", "ls", "list_directory", "find", "grep", "bash", "shell", "powershell", "run_code"] as const;

export function readSandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
  const mode = env.JEV_SANDBOX_MODE ?? "workspace-write";
  if (mode !== "off" && mode !== "read-only" && mode !== "workspace-write") throw new Error("Invalid JEV_SANDBOX_MODE");
  const image = env.JEV_SANDBOX_IMAGE ?? "node:22-bookworm-slim";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)) throw new Error("Invalid JEV_SANDBOX_IMAGE");
  const timeoutMs = env.JEV_SANDBOX_TIMEOUT_MS === undefined ? 60000 : Number(env.JEV_SANDBOX_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error("Invalid JEV_SANDBOX_TIMEOUT_MS");
  if (env.JEV_SANDBOX_DOCKER && !isAbsolute(env.JEV_SANDBOX_DOCKER)) throw new Error("JEV_SANDBOX_DOCKER must be absolute");
  return { mode, image, timeoutMs, dockerPath: env.JEV_SANDBOX_DOCKER };
}

export function operationDigest(operation: Operation): string { return createHash("sha256").update(JSON.stringify(operation)).digest("hex"); }
export function sandboxSchema(original: unknown): Record<string,unknown> {
  const schema=record(original)?JSON.parse(JSON.stringify(original)):{type:"object",properties:{}};
  schema.properties={...(record(schema.properties)?schema.properties:{}),
    sandbox_permissions:{type:"string",enum:["require_escalated"]},justification:{type:"string"},
    network_access:{type:"boolean"},read_roots:{type:"array",items:{type:"string"}},writable_roots:{type:"array",items:{type:"string"}}};
  return schema;
}
export function sandboxBoundary(plan:SandboxPlan) {
  return {backend:"docker" as const,mode:plan.writable?"workspace-write":"read-only",workspaceRoot:plan.root,
    readRoots:plan.mounts.map(m=>m.source),writableRoots:plan.mounts.filter(m=>m.write).map(m=>m.source),networkAccess:plan.network};
}
export function insideRoot(root: string, path: string): boolean { const tail=relative(root,path); return !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
const sensitive = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|\.gnupg|\.codex|\.pi|\.dsh|\.docker)(?:$|[/\\])/i;

function actionFor(operation: Operation): SandboxAction | undefined {
  const input=operation.input, tool=operation.tool;
  const path = input.path ?? input.file_path ?? input.directory ?? ".";
  if (["bash","shell","powershell"].includes(tool)) {
    if (!string(input.command)) throw new Error("Invalid sandbox command");
    return { kind:"shell", args:{command:input.command, ...(tool === "powershell" ? {shell:"powershell"} : {})} };
  }
  if (tool === "run_code") { if (!string(input.code)) throw new Error("Invalid sandbox code"); return {kind:"code",args:{code:input.code}}; }
  if (!SANDBOX_TOOL_NAMES.includes(tool as typeof SANDBOX_TOOL_NAMES[number])) return undefined;
  if (!string(path) || path.startsWith("~") || path.startsWith("@") || path.startsWith("file:") || path.includes("\0")) throw new Error("Unsupported sandbox path syntax");
  const target=resolve(operation.cwd,path);
  if (["read","read_file"].includes(tool)) {
    if ([input.offset,input.limit].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||(v as number)<1))) throw new Error("Invalid read bounds");
    return {kind:"read",args:{path:target,...(input.offset!==undefined?{offset:input.offset}:{}),...(input.limit!==undefined?{limit:input.limit}:{})}};
  }
  if (["write","write_file"].includes(tool)) { if(typeof input.content!=="string")throw new Error("Invalid write content");return {kind:"write",args:{path:target,content:input.content}}; }
  if (["edit","edit_file"].includes(tool)) {
    const edits=input.edits ?? [{oldText:input.oldText??input.old_text,newText:input.newText??input.new_text}];
    if(!Array.isArray(edits)||!edits.length||edits.some(e=>!record(e)||!string(e.oldText)||typeof e.newText!=="string"))throw new Error("Invalid edit arguments");
    return {kind:"edit",args:{path:target,edits}};
  }
  if (["ls","list_directory"].includes(tool))return {kind:"ls",args:{path:target}};
  if(!string(input.pattern))throw new Error("Invalid search pattern");
  new RegExp(input.pattern);
  return {kind:tool==="find"?"find":"grep",args:{path:target,pattern:input.pattern,limit:input.limit??100}};
}

function safeMount(path: string): boolean { return !/[\r\n,"]/.test(path) && path !== dirname(path); }
async function canonicalDirectory(path: string): Promise<string> {
  if (!safeMount(path)) throw new Error("Unsupported sandbox mount");
  const actual=await realpath(path);
  if (!(await lstat(actual)).isDirectory() || !safeMount(actual)) throw new Error("Invalid sandbox root");
  return actual;
}
async function canonicalTarget(path: string): Promise<string> {
  const missing:string[]=[];let current=path;
  while(true){try{return join(await realpath(current),...missing);}catch(error){
    if(!(error instanceof Error)||!("code" in error)||error.code!=="ENOENT")throw error;
    const parent=dirname(current);if(parent===current)throw error;missing.unshift(basename(current));current=parent;
  }}
}
function freeze<T>(value:T):T {if(value&&typeof value==="object"){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}

/** All permitted paths become explicit container mounts; no host shell or unconfined fallback exists. */
export class DockerSandbox {
  private binary?: string;
  private endpoint?: string;
  private readonly environment:NodeJS.ProcessEnv;
  private imageId?: string;
  private initialization?: Promise<void>;
  private cleanupFailed = false;
  private readonly active = new Set<string>();
  private readonly plans = new WeakMap<SandboxPlan,{consumed:boolean}>();
  readonly config: SandboxConfig;
  constructor(config: SandboxConfig) {
    this.config = Object.freeze({...config});
    this.environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>
      ["PATH","Path","HOME","USERPROFILE","SystemRoot","SYSTEMROOT","WINDIR","TEMP","TMP","APPDATA","LOCALAPPDATA","ProgramFiles",
        "DOCKER_HOST","DOCKER_CONTEXT","DOCKER_CONFIG","DOCKER_CERT_PATH","DOCKER_TLS_VERIFY","HTTP_PROXY","HTTPS_PROXY","NO_PROXY"].includes(key)));
  }

  private async invoke(args: string[], input = "", signal?: AbortSignal, timeoutMs = this.config.timeoutMs): Promise<{code:number;out:string;err:string}> {
    if (!this.binary || signal?.aborted) throw new SandboxUnavailableError();
    return new Promise((resolveResult,reject)=>{
      const child=spawn(this.binary!,this.endpoint?["--host",this.endpoint,...args]:args,{stdio:["pipe","pipe","pipe"],windowsHide:true,env:this.environment});
      let out="",err="",bytes=0,aborted=false;
      const stop=()=>{aborted=true;child.kill();};
      signal?.addEventListener("abort",stop,{once:true});
      const timer=setTimeout(stop,timeoutMs);
      for(const [stream,key] of [[child.stdout,"out"],[child.stderr,"err"]] as const)stream.on("data",data=>{
        bytes+=data.length;if(bytes>2097152){stop();return;} if(key==="out")out+=data.toString();else err+=data.toString();
      });
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener("abort",stop);};
      child.on("error",()=>{finish();reject(new SandboxUnavailableError());});
      child.on("close",code=>{finish();if(aborted)reject(new Error("Sandbox execution cancelled, timed out, or exceeded output limits"));else resolveResult({code:code??1,out,err});});
      child.stdin.on("error",()=>{});child.stdin.end(input);
    });
  }

  async ready(cwd: string): Promise<void> {
    if(this.config.mode === "off" || this.cleanupFailed)throw new SandboxUnavailableError();
    if(!this.initialization)this.initialization=(async()=>{
      const candidates=this.config.dockerPath?[this.config.dockerPath]:process.platform==="win32"?
        [join(process.env.ProgramFiles??"C:/Program Files","Docker/Docker/resources/bin/docker.exe")]:["/usr/bin/docker","/usr/local/bin/docker"];
      for(const candidate of candidates)try{const actual=await realpath(candidate);if(!insideRoot(resolve(cwd),actual)&&(await lstat(actual)).isFile()){this.binary=actual;break;}}catch{/* Try only trusted installation paths. */}
      if(!this.binary || (this.environment.DOCKER_HOST && !/^(unix:|npipe:)/.test(this.environment.DOCKER_HOST)))throw new SandboxUnavailableError();
      const endpoint=await this.invoke(["context","inspect","--format","{{json .Endpoints.docker.Host}}"]);
      if(endpoint.code!==0||!/^"(?:unix:|npipe:)/.test(endpoint.out.trim()))throw new SandboxUnavailableError();
      this.endpoint=this.environment.DOCKER_HOST??JSON.parse(endpoint.out.trim());
      delete this.environment.DOCKER_HOST;delete this.environment.DOCKER_CONTEXT;
      const image=await this.invoke(["image","inspect",this.config.image,"--format","{{.Id}}"]);
      if(image.code!==0||!/^sha256:[a-f0-9]{64}$/.test(image.out.trim()))throw new SandboxUnavailableError();
      this.imageId=image.out.trim();
    })().catch(error=>{this.initialization=undefined;throw error;});
    await this.initialization;
  }

  async prepare(operation: Operation, readOnly = false, workspaceRoot=operation.cwd): Promise<SandboxPlan | undefined> {
    const action=actionFor(operation);if(!action)return undefined;
    await this.ready(workspaceRoot);
    const root=await canonicalDirectory(resolve(workspaceRoot));
    if(sensitive.test(root))throw new Error("Credential/configuration directories cannot be the standing workspace");
    const controls=[this.binary!,process.execPath,...(this.endpoint?.startsWith("unix:")?[decodeURIComponent(new URL(this.endpoint).pathname)]:[])];
    if(controls.some(path=>insideRoot(root,resolve(path))))throw new Error("Workspace contains sandbox control-plane files");
    const writable=this.config.mode==="workspace-write"&&!readOnly;
    const mounts:SandboxMount[]=[{source:root,target:"/workspace",write:writable}];
    let requiresReview=false;
    const cwd=await canonicalDirectory(resolve(operation.cwd));
    let cwdTarget=join("/workspace",relative(root,cwd)).split(sep).join("/");
    if(!insideRoot(root,cwd)&&(action.kind==="shell"||action.kind==="code")){requiresReview=true;cwdTarget="/extra/cwd";mounts.push({source:cwd,target:cwdTarget,write:writable});}
    const network=operation.input.network_access===true;
    if(operation.input.network_access!==undefined&&typeof operation.input.network_access!=="boolean")throw new Error("Invalid network permission");
    if(network)requiresReview=true;
    for(const [field,write] of [["read_roots",false],["writable_roots",true]] as const) {
      const roots=operation.input[field];if(roots===undefined)continue;
      if(!Array.isArray(roots)||roots.length>8||roots.some(r=>typeof r!=="string"))throw new Error("Invalid requested sandbox roots");
      for(const requested of roots){const source=await canonicalDirectory(resolve(operation.cwd,requested));
        if(controls.some(path=>insideRoot(source,resolve(path))))throw new Error("Requested root includes sandbox control-plane files");
        mounts.push({source,target:`/extra/${mounts.length-1}`,write});requiresReview=true;}
    }
    let hostTarget:string|undefined;
    if(typeof action.args.path === "string") {
      const path=await canonicalTarget(action.args.path);hostTarget=path;
      const writes=action.kind==="write"||action.kind==="edit";
      const pluginRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
      const protectedWrite=writes&&[join(root,".git"),...(["src","dist","node_modules"].map(d=>join(pluginRoot,d)))].some(p=>insideRoot(p,path));
      if(!insideRoot(root,path)||(writes&&!writable)||sensitive.test(path)||protectedWrite) {
        requiresReview=true;
        let parent=dirname(path);
        while(true){try{parent=await canonicalDirectory(parent);break;}catch{const next=dirname(parent);if(next===parent)throw new Error("Unresolvable sandbox target");parent=next;}}
        if(controls.some(path=>insideRoot(parent,resolve(path))))throw new Error("Target mount includes sandbox control-plane files");
        mounts.push({source:parent,target:`/extra/${mounts.length-1}`,write:writes});
      }
      const mount=[...mounts].sort((a,b)=>b.source.length-a.source.length).find(m=>insideRoot(m.source,path));
      if(!mount)throw new Error("Unmapped sandbox target");
      action.args.path=join(mount.target,relative(mount.source,path)).split(sep).join("/");
    }
    if(operation.input.sandbox_permissions!==undefined) {
      if(operation.input.sandbox_permissions!=="require_escalated"||!string(operation.input.justification))throw new Error("Invalid sandbox escalation request");
      requiresReview=true;
    }
    const plan:SandboxPlan=freeze(JSON.parse(JSON.stringify({operation,digest:operationDigest(operation),root,action,mounts,requiresReview,network,writable,hostTarget,cwdTarget})));
    this.plans.set(plan,{consumed:false});return plan;
  }

  canRun(plan:SandboxPlan, operation:Operation):boolean {return !this.cleanupFailed&&Boolean(this.imageId)&&this.plans.get(plan)?.consumed===false&&
    !plan.requiresReview&&plan.digest===operationDigest(operation);}

  private async masks(plan: SandboxPlan): Promise<string[]> {
    const masks:string[]=[];
    for(const entry of await readdir(plan.root,{withFileTypes:true})) {
      if(sensitive.test(entry.name))masks.push(join(plan.root,entry.name));
    }
    return masks;
  }

  async execute(plan: SandboxPlan, operation: Operation, approved: boolean, signal?: AbortSignal): Promise<SandboxResult> {
    const ticket=this.plans.get(plan);
    if(!ticket||ticket.consumed||operationDigest(operation)!==plan.digest||signal?.aborted||(plan.requiresReview&&!approved))throw new Error("Sandbox action is not approved, consumed, or changed before execution");
    ticket.consumed=true;
    const actual=actionFor(operation);
    if(plan.hostTarget&&typeof actual?.args.path==="string"&&await canonicalTarget(actual.args.path)!==plan.hostTarget)throw new Error("Sandbox target changed");
    await this.ready(plan.root);
    const name=`jev-sandbox-${randomUUID()}`;
    const args=["run","--rm","-i","--pull=never","--name",name,"--read-only","--network",plan.network&&approved?"bridge":"none",
      "--cap-drop=ALL","--security-opt=no-new-privileges","--pids-limit=128","--memory=1g","--cpus=2",
      "--user",`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,"--tmpfs","/tmp:rw,nosuid,nodev,size=67108864","--workdir",plan.cwdTarget,"--entrypoint","node"];
    const mounts=plan.mounts;
    for(const mount of mounts) {
      if(await canonicalDirectory(mount.source)!==mount.source)throw new Error("Sandbox root changed");
      args.push("--mount",`type=bind,source=${mount.source},target=${mount.target}${mount.write?"":",readonly"}`);
    }
    const maskRoot=await mkdtemp(join(tmpdir(),"jev-sandbox-masks-"));
    let started=false;
    try {
    const empty=join(maskRoot,"unavailable");
    await writeFile(empty,"",{mode:0o000});
    // Hide credential/configuration data from arbitrary shell/code calls.
    for(const mask of await this.masks(plan)) {
      if(plan.requiresReview&&approved&&mounts.some(m=>m.source===mask))continue;
      if((await lstat(mask)).isDirectory())args.push("--tmpfs",`/workspace/${relative(plan.root,mask).split(sep).join("/")}:ro,nosuid,nodev,mode=000`);
      else args.push("--mount",`type=bind,source=${empty},target=/workspace/${relative(plan.root,mask).split(sep).join("/")},readonly`);
    }
    // The running plugin's source, when it lies in the workspace, remains read-only.
    const pluginRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
    for(const source of [join(plan.root,".git"),...(["src","dist","node_modules"].map(d=>join(pluginRoot,d)))]){if(!insideRoot(plan.root,source))continue;
      try{if((await lstat(source)).isDirectory())args.push("--mount",`type=bind,source=${source},target=/workspace/${relative(plan.root,source).split(sep).join("/")}${approved&&mounts.some(m=>m.write&&m.source===source)?"":",readonly"}`);}catch{/* Absent source directory. */}}
    args.push(this.imageId!,"--input-type=module","-e",SANDBOX_WORKER);
    const packet=JSON.stringify({action:plan.action,mounts:mounts.map(m=>({target:m.target,write:m.write}))});
    this.active.add(name);
    started=true;
      const run=await this.invoke(args,packet,signal);
      if(run.code!==0)throw new SandboxUnavailableError();
      const response:unknown=JSON.parse(run.out);
      if(!record(response))throw new SandboxUnavailableError();
      if(response.ok!==true)return {isError:true,text:`Sandbox operation failed: ${typeof response.error==="string"?response.error:"unknown error"}. Try a safer path within /workspace; request only the specific extra roots or network permission if necessary.`};
      if(!record(response.value)||typeof response.value.text!=="string")throw new SandboxUnavailableError();
      return {text:response.value.text,isError:typeof response.value.exitCode==="number"&&response.value.exitCode!==0,
        exitCode:typeof response.value.exitCode==="number"?response.value.exitCode:undefined,truncated:response.value.truncated===true};
    } finally {
      if(started)await this.cleanup(name,maskRoot);
      else await rm(maskRoot,{recursive:true,force:true});
    }
  }

  private async cleanup(name: string, maskRoot: string): Promise<void> {
    try {
      const removed=await this.invoke(["rm","--force",name],"",undefined,10000);
      if(removed.code!==0&&!/no such container/i.test(removed.err))throw new Error("Unconfirmed cleanup");
      this.active.delete(name);
    } catch {
      this.cleanupFailed=true;
      throw new Error("Sandbox cleanup could not be verified; execution is disabled until cleanup succeeds");
    } finally { await rm(maskRoot,{recursive:true,force:true}); }
  }

  async dispose(): Promise<void> { for(const name of this.active){const stopped=await this.invoke(["rm","--force",name],"",undefined,10000);
    if(stopped.code!==0&&!/no such container/i.test(stopped.err))throw new Error("Sandbox cleanup is not verified");this.active.delete(name);} this.cleanupFailed=false; }
}

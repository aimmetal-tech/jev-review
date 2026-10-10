import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DockerSandbox, readSandboxConfig } from "../src/sandbox.ts";
import type { Operation } from "../src/reviewer.ts";

test("sandbox configuration rejects silent fallback and argument-injected executors", () => {
  for(const env of [{JEV_SANDBOX_MODE:"full"},{JEV_SANDBOX_IMAGE:"--privileged"},{JEV_SANDBOX_DOCKER:"docker"},{JEV_SANDBOX_TIMEOUT_MS:"0"}])assert.throws(()=>readSandboxConfig(env));
  assert.equal(readSandboxConfig({}).mode,"workspace-write");
});

test("live Docker confines workspace files, process filesystem and network", {skip:process.env.JEV_TEST_DOCKER!=="1"}, async t => {
  const cwd=await mkdtemp(join(tmpdir(),"sandbox-live-"));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  await mkdir(join(cwd,"docs"));
  await writeFile(join(cwd,"docs/note.md"),"line1\nline2\nline3\n");
  await writeFile(join(cwd,".env"),"DO_NOT_EXPOSE_THIS_FIXTURE\n");
  const sandbox=new DockerSandbox(readSandboxConfig({JEV_SANDBOX_IMAGE:process.env.JEV_TEST_IMAGE??"public.ecr.aws/docker/library/node:24-alpine"}));
  t.after(()=>sandbox.dispose());
  const previous={mimo:process.env.MIMO_TP_KEY,jev:process.env.TYPESAFE_API_KEY};
  process.env.MIMO_TP_KEY="synthetic-secret-canary";process.env.TYPESAFE_API_KEY="synthetic-jev-canary";
  t.after(()=>{for(const [key,value]of Object.entries({MIMO_TP_KEY:previous.mimo,TYPESAFE_API_KEY:previous.jev})){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const operation=(tool:string,input:Record<string,unknown>):Operation=>({tool,input,cwd,source:"agent"});
  async function run(op:Operation, approved=false) {const plan=await sandbox.prepare(op);assert.ok(plan);return sandbox.execute(plan,op,approved);}
  const read=await run(operation("read",{path:"docs/note.md",limit:2}));
  assert.equal(read.isError,false);
  assert.equal(read.text,"line1\nline2");
  const write=await run(operation("write",{path:"docs/new.md",content:"sandbox write"}));
  assert.equal(write.isError,false,write.text);
  assert.equal(await readFile(join(cwd,"docs/new.md"),"utf8"),"sandbox write");
  const immutable=await run(operation("bash",{command:"printf forbidden > /etc/jev-escape"}));
  assert.equal(immutable.isError,true);
  const net=await run(operation("bash",{command:"node -e 'fetch(\"https://example.com\",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(0)).catch(()=>process.exit(3))'"}));
  assert.equal(net.exitCode,3);
  const environment=await run(operation("bash",{command:"node -e 'console.log(process.env.MIMO_TP_KEY,process.env.TYPESAFE_API_KEY)'"}));
  assert.equal(environment.text.trim(),"undefined undefined");
  const masked=await run(operation("bash",{command:"cat .env || true"}));
  assert.equal(masked.text.includes("DO_NOT_EXPOSE_THIS_FIXTURE"),false);
  const code=await run(operation("run_code",{code:"console.log(await tools.read({path:'docs/note.md',limit:1})); await tools.write({path:'docs/code.md',content:'contained code'});"}));
  assert.equal(code.isError,false,code.text);
  assert.equal(code.text.trim(),"line1");assert.equal(await readFile(join(cwd,"docs/code.md"),"utf8"),"contained code");
});

test("live Docker escalation is exact, one-shot and cannot mutate its approved payload", {skip:process.env.JEV_TEST_DOCKER!=="1"}, async t=>{
  const cwd=await mkdtemp(join(tmpdir(),"sandbox-work-")),outside=await mkdtemp(join(tmpdir(),"sandbox-outside-"));
  t.after(()=>rm(cwd,{recursive:true,force:true}));t.after(()=>rm(outside,{recursive:true,force:true}));
  const sandbox=new DockerSandbox(readSandboxConfig({JEV_SANDBOX_IMAGE:process.env.JEV_TEST_IMAGE??"public.ecr.aws/docker/library/node:24-alpine"}));
  t.after(()=>sandbox.dispose());
  const op:Operation={tool:"write",input:{path:join(outside,"one.md"),content:"approved once"},cwd,source:"agent"};
  const plan=await sandbox.prepare(op);assert.ok(plan);assert.equal(plan.requiresReview,true);
  await assert.rejects(sandbox.execute(plan,op,false),/not approved/);
  await assert.rejects(sandbox.execute(plan,{...op,input:{...op.input,content:"modified"}},true),/changed/);
  const result=await sandbox.execute(plan,op,true);assert.equal(result.isError,false,result.text);
  assert.equal(await readFile(join(outside,"one.md"),"utf8"),"approved once");
  const next=await sandbox.prepare(op);assert.ok(next);assert.equal(next.requiresReview,true);
  await assert.rejects(sandbox.execute(next,op,false),/not approved/);
  await assert.rejects(sandbox.execute(plan,op,true),/consumed/);
  const forged={...plan};await assert.rejects(sandbox.execute(forged,op,true),/not approved/);
});

test("live cancellation reaches container quiescence and read-only writes require an exception",{skip:process.env.JEV_TEST_DOCKER!=="1"},async t=>{
  const cwd=await mkdtemp(join(tmpdir(),"sandbox-cancel-"));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const sandbox=new DockerSandbox(readSandboxConfig({JEV_SANDBOX_MODE:"read-only",JEV_SANDBOX_IMAGE:process.env.JEV_TEST_IMAGE??"public.ecr.aws/docker/library/node:24-alpine"}));t.after(()=>sandbox.dispose());
  const write:Operation={tool:"write",input:{path:"one.md",content:"no standing permission"},cwd,source:"agent"};
  const readonly=await sandbox.prepare(write);assert.ok(readonly);assert.equal(readonly.requiresReview,true);
  await assert.rejects(sandbox.execute(readonly,write,false),/not approved/);
  const sleep:Operation={tool:"bash",input:{command:"sleep 20"},cwd,source:"agent"};
  const plan=await sandbox.prepare(sleep);assert.ok(plan);const controller=new AbortController();
  const started=sandbox.execute(plan,sleep,false,controller.signal);setTimeout(()=>controller.abort(),1000);
  await assert.rejects(started,/cancelled|timed out/);
  await sandbox.dispose();
});

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { assertCloud, hash } from "./core.ts";

assertCloud(process.env);
const root=process.cwd(),npm=process.env.npm_execpath;
if(!npm)throw new Error("Use npm run live:prepare");
const installed=join(process.env.RUNNER_TEMP!,"jev-live-installed");
mkdirSync(installed,{recursive:true});mkdirSync(resolve(".release"),{recursive:true});
function run(args:string[],cwd:string,capture=false):string {
  const result=spawnSync(process.execPath,[npm!,...args],{cwd,encoding:"utf8",stdio:capture?"pipe":"inherit"});
  if(result.error||result.status!==0)throw new Error("LIVE_PACKAGE_PREPARATION_FAILED");return result.stdout??"";
}
const [pack]=JSON.parse(run(["pack","--json","--silent","--pack-destination",resolve(".release")],root,true));
const tarball=resolve(".release",pack.filename);
writeFileSync(join(installed,"package.json"),JSON.stringify({private:true,type:"module"}));
run(["install","--ignore-scripts","--no-audit","--no-fund","--package-lock=false",tarball,
  "@earendil-works/pi-coding-agent@1.1.0","@deepseek-ai/dsh-sdk-client@0.2.1-alpha.2"],installed);
const controls=join(installed,"controls");mkdirSync(controls,{recursive:true});
for(const name of ["preload","pi-control","dsh-control"])await build({entryPoints:[`scripts/live/${name}.ts`],bundle:true,
  platform:"node",format:"esm",packages:"external",outfile:join(controls,`${name}.mjs`)});
writeFileSync(resolve(".release/live-prepare.json"),JSON.stringify({installed,controls,packageSha256:hash(readFileSync(tarball)),
  packageVersion:pack.version,piVersion:"1.1.0",dshVersion:"0.2.1-alpha.2"},null,2));
console.log("Prepared actual package and pinned host runtimes without model credentials.");

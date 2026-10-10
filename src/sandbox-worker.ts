/** Trusted container-side dispatcher. Agent-controlled strings never become host argv. */
export const SANDBOX_WORKER = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const req = JSON.parse(raw);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')); };
async function target(file, write = false) {
  const absolute = path.resolve(file);
  const mount = req.mounts.find(m => inside(m.target, absolute));
  if (!mount || (write && !mount.write)) throw new Error('SANDBOX_PERMISSION_DENIED');
  let current = absolute;
  while (true) { try { current = await fs.realpath(current); break; } catch (e) { if (e.code !== 'ENOENT') throw e; const parent = path.dirname(current); if (parent === current) throw e; current = parent; } }
  if (!inside(mount.target, current)) throw new Error('SANDBOX_PERMISSION_DENIED');
  return absolute;
}
async function apply(action) {
  const a = action.args;
  if (action.kind === 'read') {
    const p = await target(a.path); const stat = await fs.stat(p);
    if (!stat.isFile() || stat.size > 8388608) throw new Error('UNSUPPORTED_READ_TARGET');
    const data = await fs.readFile(p, 'utf8'); const lines = data.split('\n');
    return { text: lines.slice((a.offset ?? 1) - 1, (a.offset ?? 1) - 1 + (a.limit ?? 2000)).join('\n').slice(0, 131072) };
  }
  if (action.kind === 'write') { const p = await target(a.path, true); await fs.mkdir(path.dirname(p), {recursive:true}); await fs.writeFile(p,a.content,'utf8'); return {text:'File written in sandbox.'}; }
  if (action.kind === 'edit') {
    const p = await target(a.path, true); let data = await fs.readFile(p,'utf8');
    for (const edit of a.edits) { const index = data.indexOf(edit.oldText); if (index < 0 || data.indexOf(edit.oldText,index+1) >= 0) throw new Error('EDIT_REQUIRES_UNIQUE_MATCH'); data = data.slice(0,index)+edit.newText+data.slice(index+edit.oldText.length); }
    await fs.writeFile(p,data,'utf8'); return {text:'File edited in sandbox.'};
  }
  if (action.kind === 'ls') { const p = await target(a.path); return {text:(await fs.readdir(p,{withFileTypes:true})).map(e => e.name+(e.isDirectory()?'/':'')).sort().join('\n').slice(0,131072)}; }
  if (action.kind === 'find' || action.kind === 'grep') {
    const start = await target(a.path), found = []; let visited = 0;
    const pattern = new RegExp(a.pattern);
    async function walk(dir) {
      if (++visited > 5000 || found.length >= (a.limit ?? 100)) return;
      for (const item of await fs.readdir(dir,{withFileTypes:true})) {
        if (item.isSymbolicLink() || ['.git','node_modules','.ssh','.aws','.codex','.pi','.dsh'].includes(item.name)) continue;
        const p = await target(path.join(dir,item.name));
        if (item.isDirectory()) await walk(p);
        else if (item.isFile()) {
          if (action.kind === 'find') { if(pattern.test(path.relative(start,p))) found.push(path.relative(start,p)); }
          else { const stat=await fs.stat(p); if(stat.size>1048576)continue; const lines=(await fs.readFile(p,'utf8')).split('\n'); for(let i=0;i<lines.length;i++)if(pattern.test(lines[i]))found.push(path.relative(start,p)+':'+(i+1)+':'+lines[i]); }
        }
        if(found.length >= (a.limit ?? 100))break;
      }
    }
    await walk(start); return {text:found.slice(0,a.limit??100).join('\n').slice(0,131072)};
  }
  if (action.kind === 'shell' || action.kind === 'code') {
    let program='/bin/sh', argv=['-lc',a.command];
    if(action.kind === 'code') {
      const prelude = "globalThis.tools=await(async()=>{const fs=await import('node:fs/promises'),path=await import('node:path'),{spawn}=await import('node:child_process');"+
        "const req="+JSON.stringify({mounts:req.mounts})+";const inside="+inside.toString()+";const target="+target.toString()+";const apply="+apply.toString()+";const tools={};"+
        "for(const name of ['read','write','edit','ls','find','grep','bash']){const kind=name==='bash'?'shell':name;const fn=async args=>{const v=await apply({kind,args});return kind==='shell'?{output:v.text,exit_code:v.exitCode}:v.text;};tools[name]=fn;tools['jev_'+name]=fn;}return tools;})();"+
        "globalThis.image=x=>console.log(JSON.stringify(x));\n";
      program=process.execPath; argv=['--input-type=module','-e',prelude+a.code];
    }
    if (a.shell === 'powershell') {program='pwsh';argv=['-NoProfile','-NonInteractive','-Command',a.command];}
    const child=spawn(program,argv,{cwd:process.cwd(),env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','pipe','pipe']});
    let output='', bytes=0;
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(output.length<131072)output+=chunk.toString().slice(0,131072-output.length);});
    return await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({text:output,exitCode:code??1,truncated:bytes>131072}));});
  }
  throw new Error('UNSUPPORTED_SANDBOX_OPERATION');
}
try { const value=await apply(req.action); console.log(JSON.stringify({ok:true,value})); }
catch(e) { console.log(JSON.stringify({ok:false,error:e.code??e.message??'SANDBOX_OPERATION_FAILED'})); }
`;

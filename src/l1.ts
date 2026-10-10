import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type L1Mode = "off" | "observe" | "enforce";
export interface ReadScope { cwd: string; root: string }
export interface L1Context {
  host: "pi";
  provenance: { source: string; path: string };
  scope: ReadScope;
  /** Revalidate the adapter's UI-confirmed task binding after asynchronous checks. */
  isValid(): boolean;
}
export interface L1Operation { tool: string; input: Record<string, unknown>; cwd: string; source: string }
export interface L1Result { decision: "allow" | "defer"; ruleId: string }

export function isProtectedPath(cwd: string, path: string): boolean {
  return /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|\.gnupg|\.codex|\.pi|\.dsh|jev-review|pi-jev-review)(?:$|[/\\])/i.test(resolve(cwd, path));
}

function ordinaryPath(path: string): boolean {
  // Pi expands these syntaxes before reading. Do not approve a different target.
  return path.length > 0 && path.trim() === path &&
    !(process.platform === "win32" && /^[a-zA-Z]:[/\\]/.test(path) ? path.slice(2) : path).includes(":") &&
    !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !/^(?:[@~]|file:|[a-zA-Z]:[^/\\]|\\\\|\/\/)|[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/i.test(path) &&
    !(process.platform === "win32" && (path.startsWith("/") || path.startsWith("\\")));
}

function within(root: string, target: string, strict = false): boolean {
  const tail = relative(root, target);
  return (!strict || tail !== "") && !isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`);
}

async function checkedPath(path: string): Promise<{ path: string; directory: boolean; file: boolean }> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  // Inspect all existing components, including ancestors of cwd and the grant.
  for (const component of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Linked path");
  }
  const stat = await lstat(absolute);
  return { path: await realpath(absolute), directory: stat.isDirectory(), file: stat.isFile() };
}

/** No file contents are read, and an uncheckable scope never creates permission. */
export async function createReadScope(cwd: string, directory: string): Promise<ReadScope | undefined> {
  if (!ordinaryPath(directory) || isProtectedPath(cwd, directory)) return undefined;
  try {
    const workspace = await checkedPath(cwd);
    const root = await checkedPath(resolve(cwd, directory));
    if (!workspace.directory || !root.directory || !within(workspace.path, root.path, true) ||
        isProtectedPath(workspace.path, root.path)) return undefined;
    return { cwd: workspace.path, root: root.path };
  } catch { return undefined; }
}

/** Tool names and descriptions alone never establish a trustworthy read capability. */
export async function classifyL1(operation: L1Operation, context?: L1Context): Promise<L1Result> {
  const defer = (ruleId: string): L1Result => ({ decision: "defer", ruleId });
  if (!context || context.host !== "pi" || operation.source !== "agent" || operation.tool !== "read" ||
      context.provenance.source !== "builtin" || context.provenance.path !== "builtin:read") return defer("l1.untrusted-tool");
  try {
    if (!context.isValid()) return defer("l1.invalid-grant");
    const { path, offset, limit } = operation.input;
    if (Object.keys(operation.input).some(key => !["path", "offset", "limit"].includes(key)) ||
        typeof path !== "string" || !ordinaryPath(path) ||
        [offset, limit].some(value => value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))) {
      return defer("l1.unsupported-input");
    }
    if (isProtectedPath(operation.cwd, path)) return defer("l1.protected-path");
    const workspace = await checkedPath(operation.cwd);
    const root = await checkedPath(context.scope.root);
    const target = await checkedPath(resolve(operation.cwd, path));
    if (workspace.path !== context.scope.cwd || root.path !== context.scope.root || !workspace.directory ||
        !root.directory || !target.file || !within(workspace.path, root.path, true) ||
        !within(root.path, target.path) || isProtectedPath(workspace.path, target.path)) return defer("l1.outside-scope");
    if (!context.isValid()) return defer("l1.invalid-grant");
    return { decision: "allow", ruleId: "l1.pi-builtin-read" };
  } catch { return defer("l1.uncheckable-path"); }
}

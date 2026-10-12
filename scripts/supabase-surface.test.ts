// Keeps supabase-surface.json equal to the Supabase objects src/ actually calls, so the
// cross-repository schema assertions in TarkovTracker cover every table, column and RPC this
// Worker depends on. Update the manifest (and the TarkovTracker pgTAP file) with any change.
// RPC argument types and return types are informational here; the pgTAP file enforces them.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
type Relation = { columns: string[]; writes: string[] };
type Manifest = {
  relations: Record<string, Relation>;
  functions: Record<string, { args: [string, string][]; returns: string }>;
  auth: string[];
};
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'supabase-surface.json'), 'utf8')) as Manifest;
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
const files = sourceFiles(join(root, 'src')).map((path) => readFileSync(path, 'utf8'));
type Usage = {
  relations: Map<string, { columns: Set<string>; writes: Set<string> }>;
  rpcArgs: Map<string, Set<string>>;
  auth: Set<string>;
};
const usageFor = (usage: Usage, table: string) => {
  let entry = usage.relations.get(table);
  if (!entry) usage.relations.set(table, (entry = { columns: new Set(), writes: new Set() }));
  return entry;
};
const plainColumns = (list: string, param: string): string[] => {
  const columns = list.split(',');
  // Embedded resources, aliases and casts would need their own manifest entries.
  if (!columns.every((column) => /^\w+$/.test(column))) {
    throw new Error(`Unsupported ${param} list ${list}`);
  }
  return columns;
};
// Resolves `select=${name}` against `const name = '...'` declared in the same file.
const selectColumns = (source: string, value: string): string[] => {
  const name = /^\$\{(\w+)\}$/.exec(value)?.[1];
  const list = name ? new RegExp(`const ${name} =\\s*'([^']+)'`).exec(source)?.[1] : value;
  if (!list) throw new Error(`Unresolved select list ${value}`);
  return plainColumns(list, 'select');
};
const PAGING_PARAMS = new Set(['limit', 'offset']);
const LOGICAL_PARAMS = new Set(['or', 'and']);
// Every PostgREST query parameter other than paging names a column, whatever its operator
// (`eq`, `is`, `neq`, ranges, ...), so new filters cannot add an unrecorded dependency.
const paramColumns = (source: string, param: string): string[] => {
  const [key, value = ''] = param.split(/=(.*)/s);
  if (LOGICAL_PARAMS.has(key)) throw new Error(`Unsupported logical filter ${param}`);
  if (PAGING_PARAMS.has(key)) return [];
  if (key === 'select') return selectColumns(source, value);
  if (key === 'order') return plainColumns(value.replace(/\.\w+/g, ''), 'order');
  return plainColumns(key, 'filter');
};
const queryColumns = (source: string, query: string): string[] =>
  query
    .replace(/^\?/, '')
    .split('&')
    .filter(Boolean)
    .flatMap((param) => paramColumns(source, param));
const recordRelation = (usage: Usage, source: string, table: string, query: string) => {
  const entry = usageFor(usage, table);
  for (const column of queryColumns(source, query)) entry.columns.add(column);
  const patch = /method: 'PATCH',[\s\S]*?JSON\.stringify\(\{([^}]*)\}\)/.exec(source);
  if (!patch || !/^\?\w+=eq\./.test(query)) return;
  for (const [, column] of patch[1].matchAll(/(\w+):/g)) {
    entry.columns.add(column);
    entry.writes.add(column);
  }
};
// supporter.ts builds `/rest/v1/${table}` and passes the table and a shared query separately.
const recordDynamicRelations = (usage: Usage, source: string) => {
  const query = /`(\?[^`]*select=[^`]*)`/.exec(source)?.[1];
  const tables = [...source.matchAll(/supporterReadUrl\([^,]+,\s*'(\w+)'/g)].map((m) => m[1]);
  if (!query || tables.length === 0) throw new Error('Unresolved dynamic relation read');
  for (const table of tables) recordRelation(usage, source, table, query);
};
// Argument names are attributed by file, so a file may call one RPC; otherwise a name shared
// between RPCs (`p_user_id`, `p_token_id`) could hide an argument one of them stopped sending.
const recordRpcArgs = (usage: Usage, source: string, rpcs: Set<string>) => {
  if (rpcs.size === 0) return;
  if (rpcs.size > 1) throw new Error(`One file calls several RPCs: ${sorted(rpcs).join(', ')}`);
  const [rpc] = rpcs;
  let args = usage.rpcArgs.get(rpc);
  if (!args) usage.rpcArgs.set(rpc, (args = new Set()));
  for (const [, name] of source.matchAll(/\b(p_\w+):/g)) args.add(name);
};
const recordFile = (usage: Usage, source: string) => {
  const rpcs = new Set<string>();
  for (const [, literal] of source.matchAll(/`([^`]*)`/g)) {
    const rest = /\/rest\/v1\/(rpc\/)?(\w+|\$\{table\})(\?[^`]*)?/.exec(literal);
    const auth = /\/auth\/v1\/([\w/]+?)\/?\$\{/.exec(literal);
    if (auth) usage.auth.add(auth[1]);
    if (!rest) continue;
    if (rest[1]) rpcs.add(rest[2]);
    else if (rest[2] === '${table}') recordDynamicRelations(usage, source);
    else recordRelation(usage, source, rest[2], rest[3] ?? '');
  }
  recordRpcArgs(usage, source, rpcs);
};
const sorted = (values: Iterable<string>) => [...values].sort();
const usage: Usage = { relations: new Map(), rpcArgs: new Map(), auth: new Set() };
for (const source of files) recordFile(usage, source);
describe('Supabase surface manifest', () => {
  it('lists exactly the relations src/ reads or writes', () => {
    expect(sorted(usage.relations.keys())).toEqual(sorted(Object.keys(manifest.relations)));
  });
  it.each(Object.keys(manifest.relations))('lists exactly the %s columns src/ uses', (table) => {
    const used = usage.relations.get(table);
    expect(sorted(used?.columns ?? [])).toEqual(sorted(manifest.relations[table].columns));
    expect(sorted(used?.writes ?? [])).toEqual(sorted(manifest.relations[table].writes));
  });
  it('lists exactly the RPCs src/ calls', () => {
    expect(sorted(usage.rpcArgs.keys())).toEqual(sorted(Object.keys(manifest.functions)));
  });
  it.each(Object.keys(manifest.functions))('lists exactly the %s arguments src/ sends', (rpc) => {
    const declared = manifest.functions[rpc].args.map(([name]) => name);
    expect(sorted(usage.rpcArgs.get(rpc) ?? [])).toEqual(sorted(declared));
  });
  it('lists exactly the Auth admin endpoints src/ calls', () => {
    expect(sorted(usage.auth)).toEqual(sorted(manifest.auth));
  });
});

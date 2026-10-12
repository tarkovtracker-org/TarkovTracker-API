// Keeps supabase-surface.json equal to the Supabase objects src/ actually calls, so the
// cross-repository schema assertions in TarkovTracker cover every table, column and RPC this
// Worker depends on. Update the manifest (and the TarkovTracker pgTAP file) with any change.
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
  functions: Set<string>;
  rpcArgs: Set<string>;
  manifestRpcArgs: Set<string>;
  auth: Set<string>;
};
const usageFor = (usage: Usage, table: string) => {
  let entry = usage.relations.get(table);
  if (!entry) usage.relations.set(table, (entry = { columns: new Set(), writes: new Set() }));
  return entry;
};
// Resolves `select=${name}` against `const name = '...'` declared in the same file.
const selectColumns = (source: string, query: string): string[] => {
  const select = /select=(\$\{(\w+)\}|[\w,]+)/.exec(query);
  if (!select) return [];
  const list = select[2]
    ? new RegExp(`const ${select[2]} =\\s*'([^']+)'`).exec(source)?.[1]
    : select[1];
  if (!list) throw new Error(`Unresolved select list ${select[1]}`);
  return list.split(',');
};
const queryColumns = (source: string, query: string): string[] => [
  ...selectColumns(source, query),
  ...[...query.matchAll(/(\w+)=(?:eq|in)\./g)].map((match) => match[1]),
];
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
const recordFile = (usage: Usage, source: string) => {
  let callsRpc = false;
  for (const [, literal] of source.matchAll(/`([^`]*)`/g)) {
    const rest = /\/rest\/v1\/(rpc\/)?(\w+|\$\{table\})(\?[^`]*)?/.exec(literal);
    const auth = /\/auth\/v1\/([\w/]+?)\/?\$\{/.exec(literal);
    if (auth) usage.auth.add(auth[1]);
    if (!rest) continue;
    if (rest[1]) {
      callsRpc = true;
      usage.functions.add(rest[2]);
      for (const [name] of manifest.functions[rest[2]]?.args ?? []) usage.manifestRpcArgs.add(name);
    } else if (rest[2] === '${table}') recordDynamicRelations(usage, source);
    else recordRelation(usage, source, rest[2], rest[3] ?? '');
  }
  if (!callsRpc) return;
  for (const [, name] of source.matchAll(/\b(p_\w+):/g)) usage.rpcArgs.add(name);
};
const usage: Usage = {
  relations: new Map(),
  functions: new Set(),
  rpcArgs: new Set(),
  manifestRpcArgs: new Set(),
  auth: new Set(),
};
for (const source of files) recordFile(usage, source);
const sorted = (values: Iterable<string>) => [...values].sort();
describe('Supabase surface manifest', () => {
  it('lists exactly the relations src/ reads or writes', () => {
    expect(sorted(usage.relations.keys())).toEqual(sorted(Object.keys(manifest.relations)));
  });
  it.each(Object.keys(manifest.relations))('lists exactly the %s columns src/ uses', (table) => {
    const used = usage.relations.get(table);
    expect(sorted(used?.columns ?? [])).toEqual(sorted(manifest.relations[table].columns));
    expect(sorted(used?.writes ?? [])).toEqual(sorted(manifest.relations[table].writes));
  });
  it('lists exactly the RPCs src/ calls and their argument names', () => {
    expect(sorted(usage.functions)).toEqual(sorted(Object.keys(manifest.functions)));
    expect(sorted(usage.rpcArgs)).toEqual(sorted(usage.manifestRpcArgs));
  });
  it('lists exactly the Auth admin endpoints src/ calls', () => {
    expect(sorted(usage.auth)).toEqual(sorted(manifest.auth));
  });
});

// The layers rule (ADR-031): an import from a file of module mA (layer i) to a
// file of module mB (layer j) is allowed inside a module and downward (j > i);
// j === i is a horizontal import, j < i an upward one. Only the edges a change
// adds are reported: an (importer, target module) pair the before version of
// the file did not have. Pure: imports, file lists and tsconfig paths come in.

import type { ImportRef } from '../parse/imports.js';
import type { Status } from '../report/types.js';
import type { LayersRule, Severity } from './config.js';
import type { RuleFile, RuleViolation } from './engine.js';
import { layerModules, moduleOf, type LayerModule } from './modules.js';
import { createResolver, type TsconfigPaths } from './resolve.js';

export const LAYERS_DEFAULT_SEVERITY: Severity = 'med';

/** What the layers rule needs beyond the touched files: the snapshot's file lists and the root tsconfig's paths. */
export interface LayersContext {
  /** Every file of the after state. */
  afterFiles: ReadonlySet<string>;
  /** Every file of the before state. */
  beforeFiles: ReadonlySet<string>;
  /** Read only for a rule with `useTsconfigPaths`; null when there is none or it has no usable paths. */
  tsconfigPaths: TsconfigPaths | null;
}

export interface LayersResult {
  violations: RuleViolation[];
  /** Imports of checked files that could not be resolved. */
  unresolved: number;
}

/** Statuses whose files are checked: a file whose only change is its imports has its git status, `mod` (ADR-008). */
const CHECKED: ReadonlySet<Status> = new Set<Status>(['add', 'mod', 'sig']);

/** A changed file as git saw it, for the before file list. */
export interface ListedChange {
  path: string;
  oldPath: string | null;
  type: 'add' | 'del' | 'mod' | 'rename';
}

/** The before state's file list, from the after state's list and the changed files. Sorted. */
export function beforeFilesOf(afterFiles: Iterable<string>, changed: readonly ListedChange[]): string[] {
  const files = new Set(afterFiles);
  for (const file of changed) {
    if (file.type === 'add' || file.type === 'rename') files.delete(file.path);
    if (file.type === 'del') files.add(file.path);
    if (file.type === 'rename' && file.oldPath !== null) files.add(file.oldPath);
  }
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function counted(rule: LayersRule): (ref: ImportRef) => boolean {
  return (ref) => rule.allowTypeImports !== true || !ref.typeOnly;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The reason of a layers check: the unresolved imports, when there are some. */
export function layersReason(unresolved: number): string | undefined {
  return unresolved > 0 ? `${plural(unresolved, 'import')} could not be resolved` : undefined;
}

/** The violations of one layers rule over the touched files. The rule is valid (its modules were checked by validateRule). */
export function checkLayers(rule: LayersRule, files: readonly RuleFile[], context: LayersContext): LayersResult {
  const parsed = layerModules(rule.layers);
  // validateRule refuses such a rule; nothing to check if one gets here anyway.
  if (!parsed.ok) return { violations: [], unresolved: 0 };
  const modules: readonly LayerModule[] = parsed.modules;
  const options = { aliases: rule.aliases, tsconfigPaths: rule.useTsconfigPaths === true ? context.tsconfigPaths : null };
  const resolveAfter = createResolver(context.afterFiles, options);
  const resolveBefore = createResolver(context.beforeFiles, options);
  const keep = counted(rule);
  const violations: RuleViolation[] = [];
  let unresolved = 0;

  for (const file of files) {
    const after = file.imports?.after;
    if (!CHECKED.has(file.status) || after === null || after === undefined) continue;
    const from = moduleOf(modules, file.path);
    if (from === null) continue;
    const oldPath = file.oldPath ?? file.path;
    let earlier: Set<string> | null = null;
    // The target modules the before version imported, resolved against the before list (computed once, when needed).
    const before = (): Set<string> => {
      if (earlier !== null) return earlier;
      earlier = new Set();
      for (const ref of (file.imports?.before ?? []).filter(keep)) {
        const resolved = resolveBefore(oldPath, ref.specifier);
        if (resolved.kind !== 'file') continue;
        const target = moduleOf(modules, resolved.path);
        if (target !== null) earlier.add(target.module);
      }
      return earlier;
    };

    for (const ref of after.filter(keep)) {
      const resolved = resolveAfter(file.path, ref.specifier);
      if (resolved.kind === 'unresolved') unresolved += 1;
      if (resolved.kind !== 'file') continue;
      const to = moduleOf(modules, resolved.path);
      if (to === null || to.module === from.module || to.layer > from.layer) continue;
      if (rule.reportExisting !== true && before().has(to.module)) continue;
      const direction = to.layer === from.layer ? 'Horizontal' : 'Upward';
      violations.push({
        file: file.path,
        line: ref.line,
        title: `${direction} import: ${from.module} → ${to.module}`,
        message: `Import '${ref.specifier ?? ''}' goes from ${from.module} (layer ${String(from.layer)}) to ${to.module} (layer ${String(to.layer)}). Allowed: imports to a lower layer.`,
      });
    }
  }
  return { violations, unresolved };
}

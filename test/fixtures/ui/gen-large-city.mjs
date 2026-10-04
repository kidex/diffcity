// Writes a large, seeded Report for the change screen's scale tests and the
// headed bench (scripts/bench-city.mjs), in invented packages. The generated
// Report is made by the Playwright global setup (preset `large`) and never
// committed.
//
// Presets (--preset):
//   large  2,000 files in 40 packages, about 20,000 floors, 300 touched files
//          (the CI budgets run on it);
//   huge   8,000 files in 120 packages, about 80,000 floors, 1,200 touched
//          files (a stress run for the bench only).
// The density of the touched files, findings and steps follows the golden
// Reports: a quarter of the packages are touched, eyes and risky files are a
// minority, and a short reading path crosses the eyes files.
//
// The data follows the rules of SPEC.md section 5 so it reads like a real
// change: a file's status is the heaviest of its symbols' (sig > add > del >
// mod > same), the verdict is `same` for untouched files, `eyes` in a tier 1
// package or with a `sig` symbol, `risky` with an open high finding, else
// `ok`. The summary counts symbols by status and files by verdict.
//
// Usage: node test/fixtures/ui/gen-large-city.mjs [--preset large|huge] [--seed 7] [--out <path>]
//   --files, --packages, --touched and --floors override the preset.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRESETS = {
  large: { files: 2000, packages: 40, touched: 300, floors: 20000, out: 'report-large-city.json' },
  huge: { files: 8000, packages: 120, touched: 1200, floors: 80000, out: 'report-huge-city.json' },
};

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const presetName = option('preset', 'large');
const preset = PRESETS[presetName];
if (preset === undefined) throw new Error(`unknown preset ${presetName}: use ${Object.keys(PRESETS).join(' or ')}`);
const FILES = Number(option('files', String(preset.files)));
const PACKAGES = Number(option('packages', String(preset.packages)));
const TOUCHED = Number(option('touched', String(preset.touched)));
const FLOORS = Number(option('floors', String(preset.floors)));
const SEED = Number(option('seed', '7'));
const here = dirname(fileURLToPath(import.meta.url));
export const LARGE_CITY_PATH = join(here, 'generated', PRESETS.large.out);
const out = option('out', join(here, 'generated', preset.out));

/** mulberry32: a small seeded PRNG, so the city is the same on every run. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(SEED);
const pick = (items) => items[Math.floor(random() * items.length)];
const int = (min, max) => min + Math.floor(random() * (max - min + 1));

const AREAS = ['catalog', 'billing', 'auth', 'inventory', 'shipping', 'search', 'reports', 'notifications', 'storefront', 'admin', 'pricing', 'accounts'];
const LAYERS = ['api', 'services', 'repo', 'jobs', 'ui', 'shared', 'events', 'models'];
const NOUNS = ['order', 'cart', 'item', 'coupon', 'invoice', 'parcel', 'stock', 'review', 'user', 'refund', 'basket', 'label', 'tax', 'route'];
const SUFFIX = ['service', 'controller', 'repo', 'dto', 'mapper', 'rules', 'job', 'view', 'store', 'client', 'events', 'utils'];
const VERBS = ['load', 'save', 'find', 'apply', 'check', 'build', 'send', 'merge', 'parse', 'format', 'sync', 'count'];
const TIER1 = ['auth', 'billing', 'payment', 'session', 'security', 'migration', 'schema'];
const ORDER = { sig: 4, add: 3, del: 2, mod: 1, same: 0 };

/** A seeded shuffle (Fisher-Yates), so every preset picks the same files every run. */
function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Package sizes: uneven (0.4x to 1.6x the mean), adding up to FILES exactly.
const weights = Array.from({ length: PACKAGES }, () => 0.4 + random() * 1.2);
const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
const sizes = weights.map((weight) => Math.max(1, Math.floor((weight / weightSum) * FILES)));
for (let i = 0; sizes.reduce((sum, size) => sum + size, 0) < FILES; i = (i + 1) % PACKAGES) sizes[i] += 1;
for (let i = 0; sizes.reduce((sum, size) => sum + size, 0) > FILES; i = (i + 1) % PACKAGES) if (sizes[i] > 1) sizes[i] -= 1;

const packages = sizes.map((count, packageIndex) => {
  const area = AREAS[packageIndex % AREAS.length];
  const layer = LAYERS[Math.floor(packageIndex / AREAS.length) % LAYERS.length];
  const round = Math.floor(packageIndex / (AREAS.length * LAYERS.length));
  const path = `src/${area}/${layer}${round > 0 ? `-${String(round + 1)}` : ''}`;
  return { id: path, path, tier1: TIER1.some((word) => path.toLowerCase().includes(word)), count };
});

// The touched files sit in a quarter or so of the packages: whole packages are
// taken in a seeded order until they hold enough files, then exactly TOUCHED
// of those files are picked.
const touchedPackages = new Set();
let candidates = 0;
// One tier 1 package is touched, the rest of the change is in ordinary ones, so eyes files stay a minority.
const order = shuffled(packages);
const firstTier1 = order.find((pkg) => pkg.tier1);
const ordinary = order.filter((pkg) => !pkg.tier1);
for (const pkg of [...(firstTier1 === undefined ? [] : [firstTier1]), ...ordinary, ...order.filter((pkg) => pkg.tier1 && pkg !== firstTier1)]) {
  if (candidates >= TOUCHED) break;
  touchedPackages.add(pkg.id);
  candidates += pkg.count;
}
const candidatePaths = [];
const names = packages.map((pkg) => {
  const used = new Set();
  const list = [];
  for (let i = 0; i < pkg.count; i += 1) {
    let name;
    do name = `${pick(NOUNS)}${random() < 0.5 ? `-${pick(NOUNS)}` : ''}.${pick(SUFFIX)}.ts`;
    while (used.has(name));
    used.add(name);
    list.push(name);
    if (touchedPackages.has(pkg.id)) candidatePaths.push(`${pkg.path}/${name}`);
  }
  return list;
});
const touchedSet = new Set(shuffled(candidatePaths).slice(0, TOUCHED));

const findings = [];
const report = {
  meta: { repo: 'harbor-market', base: 'main', head: '9c1e5a7b3d2f4e6a8b0c1d2e3f4a5b6c7d8e9f01', commits: 14, generatedAt: '2026-09-30T10:00:00.000Z' },
  packages: [],
  steps: [],
  findings,
  summary: { files: 0, byStatus: { add: 0, mod: 0, sig: 0, del: 0, same: 0 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 }, tier1Files: [] },
};

// About FLOORS floors in all: 1 to 2 * mean - 1 symbols a file.
const MEAN_SYMBOLS = Math.max(1, Math.round(FLOORS / FILES));
const stepCandidates = [];

packages.forEach((pkg, packageIndex) => {
  const files = [];
  for (const name of names[packageIndex]) {
    const path = `${pkg.path}/${name}`;
    const touched = touchedSet.has(path);
    const symbolCount = int(1, 2 * MEAN_SYMBOLS - 1);
    let line = 1;
    const symbols = [];
    for (let s = 0; s < symbolCount; s += 1) {
      const length = int(3, 30);
      let status = 'same';
      if (touched) {
        const roll = random();
        status = roll < 0.35 ? 'same' : roll < 0.6 ? 'mod' : roll < 0.88 ? 'add' : roll < 0.95 ? 'del' : 'sig';
      }
      const symbolName = `${pick(VERBS)}${pick(NOUNS)[0].toUpperCase()}${pick(NOUNS).slice(1)}${String(s)}`;
      symbols.push({ id: `${path}#${symbolName}`, name: symbolName, kind: 'function', status, range: { start: line, end: line + length } });
      line += length + 2;
    }
    if (touched && symbols.every((symbol) => symbol.status === 'same')) symbols[0].status = 'mod';
    const status = symbols.reduce((heaviest, symbol) => (ORDER[symbol.status] > ORDER[heaviest] ? symbol.status : heaviest), 'same');
    let verdict = 'same';
    if (status !== 'same') {
      const changed = symbols.filter((symbol) => symbol.status !== 'same');
      if (pkg.tier1 || symbols.some((symbol) => symbol.status === 'sig')) verdict = 'eyes';
      else if (random() < 0.04) {
        const symbol = pick(changed);
        findings.push({
          id: `f-${String(findings.length + 1)}`,
          source: 'semgrep',
          severity: 'high',
          category: 'correctness',
          file: path,
          line: symbol.range.start,
          symbolId: symbol.id,
          title: 'Unchecked input reaches the query',
          message: 'The value is used without validation.',
          state: 'open',
        });
        verdict = 'risky';
      } else {
        verdict = 'ok';
        // Lesser findings put pins on the roof without changing the verdict.
        if (random() < 0.06) {
          const symbol = pick(changed);
          findings.push({
            id: `f-${String(findings.length + 1)}`,
            source: 'eslint',
            severity: random() < 0.5 ? 'med' : 'low',
            category: 'style',
            file: path,
            line: symbol.range.start,
            symbolId: symbol.id,
            title: 'Function is longer than the team prefers',
            message: 'Consider splitting it.',
            state: 'open',
          });
        }
      }
      if (verdict === 'eyes') stepCandidates.push({ path, symbol: changed.find((symbol) => symbol.status === 'sig') ?? changed[0] });
    }
    for (const symbol of symbols) report.summary.byStatus[symbol.status] += 1;
    report.summary.byVerdict[verdict] += 1;
    if (pkg.tier1 && status !== 'same') report.summary.tier1Files.push(path);
    files.push({ id: path, path, language: 'typescript', status, verdict, inSpec: null, symbols });
  }
  report.packages.push({ id: pkg.id, path: pkg.path, tier1: pkg.tier1, files });
});
report.summary.files = FILES;

// A reading path of a dozen stops through the eyes files, as the agent's walkthrough would.
shuffled(stepCandidates)
  .slice(0, 12)
  .forEach(({ path, symbol }, i) => {
    report.steps.push({
      order: i + 1,
      symbolId: symbol.id,
      fileId: path,
      why: 'The reviewer should read this change first.',
      diff: [
        { kind: 'ctx', text: `function ${symbol.name}() {` },
        { kind: 'del', text: '  return previous();' },
        { kind: 'add', text: '  return next();' },
      ],
    });
  });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report)}\n`);

// Fixture Reports and helpers for the night effects of the change screen
// (DC-80): beams, finding pins, rule X markers, the critical-floor pulse, the
// reading path, the checked rendering and the render loop. The Reports are the
// golden order-discounts Report (invented names) with steps and findings added.
// The scene's `effects()` hook says what was drawn.

import type { Page } from '@playwright/test';
import type { Finding, Report, Step } from '../../../src/core/report/types.js';
import { CONTROLLER, finding, GUARD, MIGRATION, REPO, SERVICE } from './hud.js';
import { fixtures } from './mock-api.js';

export const DTO = 'src/api/orders/orders.dto.ts';
export const MAILER = 'src/services/orders/mailer.ts';

/** Floor height and step, as the layout (model/city.ts) has them. */
export const FLOOR_H = 0.5;
export const FLOOR_STEP = 0.56;

export interface Marker {
  kind: 'pin' | 'x' | 'check' | 'rewrite' | 'notch';
  file: string;
  floor: number | null;
  severity: 'high' | 'med' | 'low' | null;
  x: number;
  y: number;
  z: number;
  dimmed: boolean;
}

export interface Effects {
  mode: 'animated' | 'static';
  pulsing: number;
  halos: number;
  pulse: Record<string, { floors: number[]; phase: number }>;
  checked: Record<string, number[]>;
  gains: Record<string, { floor: number; gain: number }[]>;
  markers: Marker[];
  path: { stops: number[]; tube: boolean; animated: boolean; visible: boolean; atlas: { width: number; height: number; max: number } } | null;
  tier: { ring: boolean; opacity: number };
  continuous: boolean;
}

export const effects = (page: Page): Promise<Effects> => page.evaluate<Effects>('window.diffcityScene.effects()');

/** The symbol id of `name` in `fileId` of `report`. */
export function symbolId(report: Report, fileId: string, name: string): string {
  const symbol = report.packages.flatMap((pkg) => pkg.files).find((file) => file.id === fileId)?.symbols.find((candidate) => candidate.name === name);
  if (symbol === undefined) throw new Error(`${fileId} has no symbol ${name}`);
  return symbol.id;
}

/** The floor index of `name` in `fileId`: symbols bottom to top in source order. */
export function floorIndex(report: Report, fileId: string, name: string): number {
  const file = report.packages.flatMap((pkg) => pkg.files).find((candidate) => candidate.id === fileId);
  if (file === undefined) throw new Error(`${fileId} is not in the Report`);
  const sorted = [...file.symbols].sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id));
  const index = sorted.findIndex((symbol) => symbol.name === name);
  if (index === -1) throw new Error(`${fileId} has no symbol ${name}`);
  return index;
}

/** The number of floors of `fileId`. */
export function floorCount(report: Report, fileId: string): number {
  const file = report.packages.flatMap((pkg) => pkg.files).find((candidate) => candidate.id === fileId);
  return Math.max(file?.symbols.length ?? 1, 1);
}

function step(report: Report, order: number, fileId: string, name: string): Step {
  return { order, symbolId: symbolId(report, fileId, name), fileId, why: `Step ${String(order)} of the walk`, diff: [{ kind: 'add', text: '+ changed line' }] };
}

/**
 * The golden Report with a four-step reading path, a rule violation on a
 * floor and one on a roof, a change-level rule finding (no marker), pins of
 * every severity, a high finding on an ok file's floor and one with no symbol
 * (pulse on the roof).
 */
export function effectsReport(): Report {
  const report = fixtures.reportGolden();
  report.steps = [
    step(report, 1, GUARD, 'OrderGuard.canPlace'),
    step(report, 2, SERVICE, 'OrdersService.place'),
    step(report, 3, CONTROLLER, 'OrdersController.create'),
    step(report, 4, REPO, 'OrdersRepo.insert'),
  ];
  const findings: Finding[] = [
    finding('rule-floor', 'rule:file-size', SERVICE, { symbolId: symbolId(report, SERVICE, 'OrdersService.calcTotal'), severity: 'low', category: 'style' }),
    finding('rule-roof', 'rule:layers', REPO, { severity: 'med', category: 'architecture' }),
    finding('rule-change', 'rule:ci', '', { severity: 'high', category: 'tests' }),
    finding('pin-high', 'claude', GUARD, { severity: 'high', symbolId: symbolId(report, GUARD, 'OrderGuard.canPlace'), category: 'security' }),
    finding('pin-med', 'claude', CONTROLLER, { severity: 'med' }),
    finding('pin-low', 'semgrep', MIGRATION, { severity: 'low' }),
    finding('ok-high-floor', 'claude', DTO, { severity: 'high', symbolId: symbolId(report, DTO, 'CreateOrderDto.from'), category: 'correctness' }),
    finding('ok-high-roof', 'claude', MAILER, { severity: 'high', category: 'correctness' }),
  ];
  report.findings = findings;
  return report;
}

/**
 * A change nothing pulses or breathes in: no tier 1 package, no eyes or risky
 * file, no high finding, no steps. The loop has nothing to run for.
 */
export function calmReport(): Report {
  const report = fixtures.reportGolden();
  report.packages = report.packages
    .filter((pkg) => !pkg.tier1)
    .map((pkg) => ({ ...pkg, files: pkg.files.map((file) => ({ ...file, verdict: file.verdict === 'eyes' ? ('ok' as const) : file.verdict })) }));
  report.steps = [];
  report.findings = [];
  return report;
}

/**
 * `report` (any size) with every effect on: a path through its first files,
 * a rule X on a floor and on a roof, pins of every severity, a high finding
 * with and without a symbol. Marks come from `marksFor`.
 */
export function withEveryEffect(report: Report): Report {
  const files = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same' && file.symbols.length > 0);
  const [a, b, c, d, e, f, g] = files;
  if (g === undefined) throw new Error('not enough touched files');
  report.steps = [a, b, c, d].map((file, i) => ({
    order: i + 1,
    symbolId: file?.symbols[0]?.id ?? '',
    fileId: file?.id ?? '',
    why: 'on the path',
    diff: [],
  }));
  const make = (id: string, source: string, severity: Finding['severity'], file: string, symbol?: string): Finding =>
    finding(id, source, file, { severity, ...(symbol === undefined ? {} : { symbolId: symbol }) });
  report.findings = [
    ...report.findings,
    make('fx-rule-floor', 'rule:file-size', 'low', a?.path ?? '', a?.symbols[0]?.id),
    make('fx-rule-roof', 'rule:layers', 'med', b?.path ?? ''),
    make('fx-pin-high', 'claude', 'high', c?.path ?? '', c?.symbols[0]?.id),
    make('fx-pin-med', 'claude', 'med', d?.path ?? ''),
    make('fx-pin-low', 'semgrep', 'low', e?.path ?? ''),
    make('fx-high-roof', 'claude', 'high', f?.path ?? ''),
  ];
  return report;
}

/** Marks that put every checked rendering on screen: a checked file, a rewrite floor, one outdated. */
export function marksFor(report: Report): { files: Record<string, string>; symbols: Record<string, string> } {
  const files = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same' && file.symbols.length > 1);
  const [a, b, c] = files;
  if (c === undefined) throw new Error('not enough touched files');
  return {
    files: { [a?.id ?? '']: 'good' },
    symbols: { [b?.symbols[0]?.id ?? '']: 'rewrite', [c.symbols[0]?.id ?? '']: 'outdated' },
  };
}

/**
 * Makes the page report `hidden` for `document.visibilityState` and tells it,
 * as a browser does when the tab goes away or comes back.
 */
export async function setTabVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ${JSON.stringify(visible ? 'visible' : 'hidden')} });
    document.dispatchEvent(new Event('visibilitychange'));
  })()`);
}

/** Frames drawn in `ms`. */
export async function framesIn(page: Page, ms: number): Promise<number> {
  const before = await page.evaluate<number>('window.diffcityScene.stats().frames');
  await page.waitForTimeout(ms);
  return (await page.evaluate<number>('window.diffcityScene.stats().frames')) - before;
}

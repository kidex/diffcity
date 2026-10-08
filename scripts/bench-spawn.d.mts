// Types of scripts/bench-spawn.mjs, for its unit test.

export interface ScenarioRecord {
  name: string;
  launchedBy: string;
  runs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface BenchRecord {
  platform: NodeJS.Platform;
  node: string;
  loadavg: number[];
  runs: number;
  /** Whether the bench's shim carries com.apple.provenance; null off macOS. */
  shimProvenance: boolean | null;
  scenarios: ScenarioRecord[];
}

export const SCENARIOS: string[];
export function summarize(name: string, samples: number[]): ScenarioRecord;
export function runBench(options?: { runs?: number; scenarios?: string[]; timeoutMs?: number }): Promise<BenchRecord>;
export function formatTable(record: BenchRecord): string;

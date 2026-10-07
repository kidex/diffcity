import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Finding, Step } from '../../../src/core/report/types.js';

describe('types', () => {
  it('step-section-optional', () => {
    const legacy: Step = { order: 1, symbolId: 'a.ts#f', fileId: 'a.ts', why: 'new route', diff: [] };
    const sectioned: Step = { ...legacy, section: 'unconnected', entry: 'a.ts#main' };
    expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
    expect(sectioned.section).toBe('unconnected');
    expectTypeOf<Step['section']>().toEqualTypeOf<'path' | 'migration' | 'unconnected' | undefined>();
    expectTypeOf<Step['entry']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Finding['sources']>().toEqualTypeOf<string[] | undefined>();
  });
});

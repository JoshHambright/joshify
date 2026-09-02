import { describe, expect, it } from 'vitest';
import { err, isErr, isOk, ok, type Result } from './result.js';

/**
 * Returned from a function rather than assigned to a const, so the value keeps
 * its declared union type. A `const` annotated as `Result` is narrowed to a
 * single branch by TypeScript's assignment narrowing, which is exactly the
 * trap documented in result.ts.
 */
const succeed = (): Result<number, string> => ok(1);
const fail = (): Result<number, string> => err('boom');

describe('Result', () => {
  it('constructs a success', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('constructs a failure', () => {
    expect(err('nope')).toEqual({ ok: false, error: 'nope' });
  });

  describe('isOk', () => {
    it('is true for a success, and narrows to the value', () => {
      const result = succeed();
      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe(1);
      }
    });

    it('is false for a failure', () => {
      expect(isOk(fail())).toBe(false);
    });
  });

  describe('isErr', () => {
    it('is true for a failure, and narrows to the error', () => {
      const result = fail();
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBe('boom');
      }
    });

    it('is false for a success', () => {
      expect(isErr(succeed())).toBe(false);
    });
  });
});

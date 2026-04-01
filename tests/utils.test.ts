import { describe, it, expect } from 'vitest';
import { countLines, truncate, formatMs, relativePath } from '../src/utils';
import * as path from 'path';

describe('countLines', () => {
    it('counts single line', () => {
        expect(countLines('hello')).toBe(1);
    });

    it('counts multiple lines', () => {
        expect(countLines('a\nb\nc')).toBe(3);
    });

    it('counts empty string as 1 line', () => {
        expect(countLines('')).toBe(1);
    });

    it('counts trailing newline', () => {
        expect(countLines('a\nb\n')).toBe(3);
    });

    it('matches split behavior for typical code', () => {
        const code = 'function a() {\n  return 1;\n}\n';
        expect(countLines(code)).toBe(code.split('\n').length);
    });

    it('handles large content efficiently', () => {
        const big = 'line\n'.repeat(100000);
        const start = performance.now();
        const count = countLines(big);
        const elapsed = performance.now() - start;
        expect(count).toBe(100001);
        expect(elapsed).toBeLessThan(100); // should be very fast
    });
});

describe('truncate', () => {
    it('returns string as-is if under limit', () => {
        expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates and adds ellipsis', () => {
        expect(truncate('hello world', 5)).toBe('hello...');
    });

    it('handles exact limit', () => {
        expect(truncate('hello', 5)).toBe('hello');
    });
});

describe('formatMs', () => {
    it('formats milliseconds', () => {
        expect(formatMs(50)).toBe('50ms');
    });

    it('formats seconds', () => {
        expect(formatMs(1500)).toBe('1.50s');
    });
});

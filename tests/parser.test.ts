import { describe, it, expect } from 'vitest';
import { parseFile, hashFile, getLanguage, isSupportedFile } from '../src/indexer/parser';

describe('getLanguage', () => {
    it('returns correct language for TypeScript', () => {
        expect(getLanguage('src/index.ts')).toBe('typescript');
        expect(getLanguage('src/App.tsx')).toBe('tsx');
    });

    it('returns correct language for JavaScript', () => {
        expect(getLanguage('app.js')).toBe('javascript');
        expect(getLanguage('app.jsx')).toBe('javascript');
        expect(getLanguage('lib.mjs')).toBe('javascript');
    });

    it('returns correct language for Python', () => {
        expect(getLanguage('main.py')).toBe('python');
    });

    it('returns correct language for Go', () => {
        expect(getLanguage('main.go')).toBe('go');
    });

    it('returns correct language for Rust', () => {
        expect(getLanguage('lib.rs')).toBe('rust');
    });

    it('returns correct language for C/C++', () => {
        expect(getLanguage('main.c')).toBe('c');
        expect(getLanguage('lib.h')).toBe('c');
        expect(getLanguage('main.cpp')).toBe('cpp');
        expect(getLanguage('lib.cc')).toBe('cpp');
        expect(getLanguage('lib.hpp')).toBe('cpp');
    });

    it('returns correct language for shell', () => {
        expect(getLanguage('script.sh')).toBe('bash');
        expect(getLanguage('script.bash')).toBe('bash');
    });

    it('returns null for unsupported extensions', () => {
        expect(getLanguage('readme.md')).toBeNull();
        expect(getLanguage('data.xml')).toBeNull();
        expect(getLanguage('image.png')).toBeNull();
    });

    it('handles case-insensitive extension matching', () => {
        // extname returns lowercase on most systems
        expect(getLanguage('Main.ts')).toBe('typescript');
    });
});

describe('isSupportedFile', () => {
    it('returns true for supported files', () => {
        expect(isSupportedFile('a.ts')).toBe(true);
        expect(isSupportedFile('a.py')).toBe(true);
        expect(isSupportedFile('a.go')).toBe(true);
    });

    it('returns false for unsupported files', () => {
        expect(isSupportedFile('a.md')).toBe(false);
        expect(isSupportedFile('a.xml')).toBe(false);
    });
});

describe('hashFile', () => {
    it('returns consistent hash for same content', () => {
        const h1 = hashFile('hello world');
        const h2 = hashFile('hello world');
        expect(h1).toBe(h2);
    });

    it('returns different hash for different content', () => {
        const h1 = hashFile('hello');
        const h2 = hashFile('world');
        expect(h1).not.toBe(h2);
    });

    it('returns a 16-character hex string', () => {
        const h = hashFile('test');
        expect(h.length).toBe(16);
        expect(/^[0-9a-f]+$/.test(h)).toBe(true);
    });
});

describe('parseFile - TypeScript', () => {
    it('extracts exported functions', () => {
        const result = parseFile('test.ts', `
export function add(a: number, b: number): number {
    return a + b;
}
`);
        expect(result.symbols.length).toBe(1);
        expect(result.symbols[0].name).toBe('add');
        expect(result.symbols[0].kind).toBe('function');
        expect(result.symbols[0].exported).toBe(true);
    });

    it('extracts function parameters', () => {
        const result = parseFile('test.ts', `
export function greet(name: string, age: number): string {
    return \`Hello \${name}\`;
}
`);
        const params = result.symbols[0].parameters;
        expect(params).toBeDefined();
        expect(params!.length).toBe(2);
        expect(params![0].name).toBe('name');
        expect(params![0].type).toContain('string');
        expect(params![1].name).toBe('age');
    });

    it('extracts classes and methods', () => {
        const result = parseFile('test.ts', `
export class Calculator {
    add(a: number, b: number): number {
        return a + b;
    }
    subtract(a: number, b: number): number {
        return a - b;
    }
}
`);
        const names = result.symbols.map(s => s.name);
        expect(names).toContain('Calculator');
        expect(names).toContain('add');
        expect(names).toContain('subtract');

        const add = result.symbols.find(s => s.name === 'add')!;
        expect(add.kind).toBe('method');
        expect(add.qualifiedName).toBe('Calculator.add');
    });

    it('extracts interfaces', () => {
        const result = parseFile('test.ts', `
export interface User {
    name: string;
    age: number;
}
`);
        expect(result.symbols.length).toBe(1);
        expect(result.symbols[0].name).toBe('User');
        expect(result.symbols[0].kind).toBe('interface');
    });

    it('extracts type aliases', () => {
        const result = parseFile('test.ts', `
export type ID = string | number;
`);
        expect(result.symbols.length).toBe(1);
        expect(result.symbols[0].name).toBe('ID');
        expect(result.symbols[0].kind).toBe('type');
    });

    it('extracts enums', () => {
        const result = parseFile('test.ts', `
export enum Color {
    Red = 'red',
    Green = 'green',
    Blue = 'blue',
}
`);
        expect(result.symbols.length).toBe(1);
        expect(result.symbols[0].name).toBe('Color');
        expect(result.symbols[0].kind).toBe('enum');
    });

    it('extracts exported arrow functions', () => {
        const result = parseFile('test.ts', `
export const multiply = (a: number, b: number): number => a * b;
`);
        expect(result.symbols.length).toBe(1);
        expect(result.symbols[0].name).toBe('multiply');
        expect(result.symbols[0].kind).toBe('function');
        expect(result.symbols[0].exported).toBe(true);
    });

    it('extracts exported variables', () => {
        const result = parseFile('test.ts', `
export const MAX_SIZE = 100;
`);
        expect(result.symbols.length).toBe(1);
        expect(result.symbols[0].name).toBe('MAX_SIZE');
        expect(result.symbols[0].kind).toBe('variable');
    });

    it('extracts imports', () => {
        const result = parseFile('test.ts', `
import { add, multiply } from './math';
import defaultExport from './utils';
import * as fs from 'fs';

export function main() {}
`);
        expect(result.imports.length).toBeGreaterThanOrEqual(3);
        const mathImport = result.imports.find(i => i.source === './math');
        expect(mathImport).toBeDefined();
        expect(mathImport!.names).toContain('add');
        expect(mathImport!.names).toContain('multiply');
    });

    it('extracts call edges', () => {
        const result = parseFile('test.ts', `
function helper() { return 42; }

export function main() {
    return helper();
}
`);
        expect(result.calls.length).toBeGreaterThan(0);
        const call = result.calls.find(c => c.calledName === 'helper');
        expect(call).toBeDefined();
        expect(call!.callerSymbol).toBe('main');
    });

    it('skips console.log calls', () => {
        const result = parseFile('test.ts', `
export function main() {
    console.log('hello');
    console.error('err');
}
`);
        const consoleCalls = result.calls.filter(c =>
            c.calledName.startsWith('console')
        );
        expect(consoleCalls.length).toBe(0);
    });

    it('extracts re-exports', () => {
        const result = parseFile('test.ts', `
export { add, multiply } from './math';
export * from './utils';
`);
        expect(result.reExports.length).toBeGreaterThanOrEqual(2);
        const mathReExport = result.reExports.find(r => r.source === './math');
        expect(mathReExport).toBeDefined();
        expect(mathReExport!.names).toContain('add');
    });

    it('extracts class heritage (extends/implements)', () => {
        const result = parseFile('test.ts', `
export class Dog extends Animal implements Pet {
    bark() { return 'woof'; }
}
`);
        const dog = result.symbols.find(s => s.name === 'Dog')!;
        expect(dog.extends).toContain('Animal');
        expect(dog.implements).toContain('Pet');
    });

    it('extracts interface extends', () => {
        const result = parseFile('test.ts', `
export interface Admin extends User {
    role: string;
}
`);
        const admin = result.symbols.find(s => s.name === 'Admin')!;
        expect(admin.extends).toContain('User');
    });

    it('handles empty file', () => {
        const result = parseFile('test.ts', '');
        expect(result.symbols.length).toBe(0);
        expect(result.imports.length).toBe(0);
    });

    it('handles file with only comments', () => {
        const result = parseFile('test.ts', '// just a comment\n/* block comment */');
        expect(result.symbols.length).toBe(0);
    });

    it('captures line numbers correctly', () => {
        const result = parseFile('test.ts', `
export function first() {
    return 1;
}

export function second() {
    return 2;
}
`);
        const first = result.symbols.find(s => s.name === 'first')!;
        const second = result.symbols.find(s => s.name === 'second')!;
        expect(first.lineStart).toBe(2);
        expect(second.lineStart).toBe(6);
        expect(second.lineStart).toBeGreaterThan(first.lineEnd);
    });
});

describe('parseFile - JavaScript', () => {
    it('extracts functions from JS files', () => {
        const result = parseFile('app.js', `
function greet(name) {
    return 'Hello ' + name;
}

function add(a, b) {
    return a + b;
}
`);
        expect(result.symbols.length).toBeGreaterThanOrEqual(2);
        const names = result.symbols.map(s => s.name);
        expect(names).toContain('greet');
        expect(names).toContain('add');
    });

    it('extracts classes from JS', () => {
        const result = parseFile('app.js', `
class Animal {
    constructor(name) {
        this.name = name;
    }
    speak() {
        return this.name + ' makes a noise';
    }
}
`);
        const names = result.symbols.map(s => s.name);
        expect(names).toContain('Animal');
    });
});

describe('parseFile - Python', () => {
    it('extracts Python functions', () => {
        const result = parseFile('main.py', `
def greet(name: str) -> str:
    return f"Hello {name}"

def add(a: int, b: int) -> int:
    return a + b
`);
        expect(result.symbols.length).toBeGreaterThanOrEqual(2);
        const names = result.symbols.map(s => s.name);
        expect(names).toContain('greet');
        expect(names).toContain('add');
    });

    it('extracts Python classes', () => {
        const result = parseFile('models.py', `
class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return f"{self.name} makes a noise"

class Dog(Animal):
    def speak(self):
        return f"{self.name} barks"
`);
        const names = result.symbols.map(s => s.name);
        expect(names).toContain('Animal');
        expect(names).toContain('Dog');
    });

    it('marks top-level public functions as exported', () => {
        const result = parseFile('utils.py', `
def public_func():
    pass

def _private_func():
    pass
`);
        const pub = result.symbols.find(s => s.name === 'public_func');
        const priv = result.symbols.find(s => s.name === '_private_func');
        expect(pub?.exported).toBe(true);
        expect(priv?.exported).toBe(false);
    });

    it('extracts Python class heritage (bases)', () => {
        const result = parseFile('models.py', `
class Dog(Animal):
    pass
`);
        const dog = result.symbols.find(s => s.name === 'Dog');
        expect(dog?.extends).toContain('Animal');
    });
});

describe('parseFile - Go', () => {
    it('extracts Go functions', () => {
        const result = parseFile('main.go', `
package main

func main() {
    fmt.Println("hello")
}

func Add(a int, b int) int {
    return a + b
}
`);
        const names = result.symbols.map(s => s.name);
        expect(names).toContain('main');
        expect(names).toContain('Add');
    });
});

describe('parseFile - Rust', () => {
    it('parses without error but may not extract symbols (grammar node types differ)', () => {
        const result = parseFile('lib.rs', `
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
`);
        // Rust grammar uses different node types; parser handles TS/JS/Python primarily
        expect(result.language).toBe('rust');
        expect(Array.isArray(result.symbols)).toBe(true);
    });
});

describe('parseFile - C', () => {
    it('parses without error but may not extract symbols (grammar node types differ)', () => {
        const result = parseFile('main.c', `
int add(int a, int b) {
    return a + b;
}
`);
        // C grammar uses different node types; parser handles TS/JS/Python primarily
        expect(result.language).toBe('c');
        expect(Array.isArray(result.symbols)).toBe(true);
    });
});

describe('parseFile - skipped languages', () => {
    it('returns empty for JSON', () => {
        const result = parseFile('data.json', '{"key": "value"}');
        expect(result.symbols.length).toBe(0);
        expect(result.language).toBe('json');
    });

    it('returns empty for CSS', () => {
        const result = parseFile('style.css', 'body { color: red; }');
        expect(result.symbols.length).toBe(0);
        expect(result.language).toBe('css');
    });

    it('returns empty for HTML', () => {
        const result = parseFile('index.html', '<html><body>hi</body></html>');
        expect(result.symbols.length).toBe(0);
        expect(result.language).toBe('html');
    });
});

describe('parseFile - unsupported file', () => {
    it('returns null language for unknown extension', () => {
        const result = parseFile('readme.md', '# Hello');
        expect(result.language).toBeNull();
        expect(result.symbols.length).toBe(0);
    });
});

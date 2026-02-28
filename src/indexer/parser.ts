import * as crypto from 'crypto';
import * as path from 'path';

// Tree-sitter imports — loaded lazily
let Parser: any;
const grammars: Map<string, any> = new Map();
let treeSitterLoaded = false;

function loadTreeSitter(): boolean {
    if (treeSitterLoaded) return true;
    try {
        Parser = require('tree-sitter');
        treeSitterLoaded = true;
        return true;
    } catch {
        return false;
    }
}

const EXTENSION_MAP: Record<string, { grammar: string; module: string }> = {
    '.ts': { grammar: 'typescript', module: 'tree-sitter-typescript/typescript' },
    '.tsx': { grammar: 'tsx', module: 'tree-sitter-typescript/tsx' },
    '.js': { grammar: 'javascript', module: 'tree-sitter-javascript' },
    '.jsx': { grammar: 'javascript', module: 'tree-sitter-javascript' },
    '.mjs': { grammar: 'javascript', module: 'tree-sitter-javascript' },
    '.py': { grammar: 'python', module: 'tree-sitter-python' },
    '.rs': { grammar: 'rust', module: 'tree-sitter-rust' },
    '.go': { grammar: 'go', module: 'tree-sitter-go' },
    '.sh': { grammar: 'bash', module: 'tree-sitter-bash' },
    '.bash': { grammar: 'bash', module: 'tree-sitter-bash' },
    '.c': { grammar: 'c', module: 'tree-sitter-c' },
    '.h': { grammar: 'c', module: 'tree-sitter-c' },
    '.cpp': { grammar: 'cpp', module: 'tree-sitter-cpp' },
    '.cc': { grammar: 'cpp', module: 'tree-sitter-cpp' },
    '.hpp': { grammar: 'cpp', module: 'tree-sitter-cpp' },
    '.json': { grammar: 'json', module: 'tree-sitter-json' },
    '.css': { grammar: 'css', module: 'tree-sitter-css' },
    '.html': { grammar: 'html', module: 'tree-sitter-html' },
    '.htm': { grammar: 'html', module: 'tree-sitter-html' },
};

function getParser(language: string): any | null {
    if (!loadTreeSitter()) return null;

    if (grammars.has(language)) return grammars.get(language);

    const entry = Object.values(EXTENSION_MAP).find(e => e.grammar === language);
    if (!entry) return null;

    try {
        const lang = require(entry.module);
        const parser = new Parser();
        parser.setLanguage(lang);
        grammars.set(language, parser);
        return parser;
    } catch {
        grammars.set(language, null);
        return null;
    }
}

export function getLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext]?.grammar || null;
}

export function isSupportedFile(filePath: string): boolean {
    return getLanguage(filePath) !== null;
}

export function hashFile(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface ExtractedSymbol {
    name: string;
    qualifiedName?: string;
    kind: string;
    lineStart: number;
    lineEnd: number;
    signature?: string;
    docstring?: string;
    content?: string;
    exported?: boolean;
}

export interface ExtractedImport {
    source: string;
    names: string[];
    isDefault: boolean;
}

export interface ExtractedCall {
    callerSymbol: string;
    calledName: string;
    line: number;
}

export interface ParseResult {
    symbols: ExtractedSymbol[];
    imports: ExtractedImport[];
    calls: ExtractedCall[];
    language: string | null;
}

const SKIP_CALLS = new Set(['console.log', 'console.error', 'console.warn', 'console.info', 'console.debug', 'print', 'require']);

export function parseFile(filePath: string, content: string): ParseResult {
    const language = getLanguage(filePath);
    if (!language) return { symbols: [], imports: [], calls: [], language: null };

    // Skip parsing for JSON/CSS/HTML — no meaningful symbols
    if (['json', 'css', 'html'].includes(language)) {
        return { symbols: [], imports: [], calls: [], language };
    }

    const parser = getParser(language);
    if (!parser) return { symbols: [], imports: [], calls: [], language };

    let tree: any;
    try {
        tree = parser.parse(content);
    } catch {
        return { symbols: [], imports: [], calls: [], language };
    }

    const lines = content.split('\n');
    const symbols: ExtractedSymbol[] = [];
    const imports: ExtractedImport[] = [];
    const calls: ExtractedCall[] = [];

    function getDocstring(node: any): string | undefined {
        const prev = node.previousNamedSibling;
        if (prev && prev.type === 'comment') {
            return prev.text.slice(0, 500);
        }
        return undefined;
    }

    function getSignature(node: any): string {
        const startRow = node.startPosition.row;
        return lines[startRow]?.trim().slice(0, 200) || '';
    }

    function getContent(node: any, maxLen: number): string {
        return node.text.slice(0, maxLen);
    }

    function isExported(node: any): boolean {
        const parent = node.parent;
        if (!parent) return false;
        if (parent.type === 'export_statement' || parent.type === 'export_declaration') return true;
        if (parent.type === 'decorated_definition') {
            const pp = parent.parent;
            if (pp && (pp.type === 'export_statement' || pp.type === 'export_declaration')) return true;
        }
        // Python: top-level definitions without underscore prefix
        if (['python'].includes(language!)) {
            if (parent.type === 'module') {
                const nameNode = node.childForFieldName('name');
                if (nameNode && !nameNode.text.startsWith('_')) return true;
            }
        }
        return false;
    }

    function findEnclosingSymbol(node: any): string | null {
        let cur = node.parent;
        while (cur) {
            if (['function_declaration', 'function_definition', 'method_definition',
                 'arrow_function', 'class_declaration', 'class_definition'].includes(cur.type)) {
                const nameNode = cur.childForFieldName('name');
                if (nameNode) return nameNode.text;
            }
            // Handle variable declarations with arrow functions
            if (cur.type === 'variable_declarator' || cur.type === 'lexical_declaration') {
                const nameNode = cur.childForFieldName('name') ||
                    (cur.type === 'lexical_declaration' ? cur.firstNamedChild?.childForFieldName('name') : null);
                if (nameNode) return nameNode.text;
            }
            cur = cur.parent;
        }
        return null;
    }

    function walkNode(node: any, className?: string) {
        const type = node.type;

        // Symbols
        if (['function_declaration', 'function_definition'].includes(type)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    qualifiedName: className ? `${className}.${nameNode.text}` : undefined,
                    kind: 'function',
                    lineStart: node.startPosition.row + 1,
                    lineEnd: node.endPosition.row + 1,
                    signature: getSignature(node),
                    docstring: getDocstring(node),
                    content: getContent(node, 2048),
                    exported: isExported(node),
                });
            }
        } else if (type === 'method_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    qualifiedName: className ? `${className}.${nameNode.text}` : undefined,
                    kind: 'method',
                    lineStart: node.startPosition.row + 1,
                    lineEnd: node.endPosition.row + 1,
                    signature: getSignature(node),
                    docstring: getDocstring(node),
                    content: getContent(node, 2048),
                    exported: isExported(node),
                });
            }
        } else if (['class_declaration', 'class_definition'].includes(type)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                const name = nameNode.text;
                symbols.push({
                    name,
                    kind: 'class',
                    lineStart: node.startPosition.row + 1,
                    lineEnd: node.endPosition.row + 1,
                    signature: getSignature(node),
                    docstring: getDocstring(node),
                    content: getContent(node, 3072),
                    exported: isExported(node),
                });
                // Walk children with class context
                for (let i = 0; i < node.childCount; i++) {
                    walkNode(node.child(i), name);
                }
                return; // Don't double-walk children
            }
        } else if (type === 'interface_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: 'interface',
                    lineStart: node.startPosition.row + 1,
                    lineEnd: node.endPosition.row + 1,
                    signature: getSignature(node),
                    docstring: getDocstring(node),
                    content: getContent(node, 3072),
                    exported: isExported(node),
                });
            }
        } else if (type === 'type_alias_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: 'type',
                    lineStart: node.startPosition.row + 1,
                    lineEnd: node.endPosition.row + 1,
                    signature: getSignature(node),
                    content: getContent(node, 2048),
                    exported: isExported(node),
                });
            }
        } else if (type === 'enum_declaration') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: 'enum',
                    lineStart: node.startPosition.row + 1,
                    lineEnd: node.endPosition.row + 1,
                    signature: getSignature(node),
                    content: getContent(node, 2048),
                    exported: isExported(node),
                });
            }
        } else if (type === 'lexical_declaration' || type === 'variable_declaration') {
            if (isExported(node)) {
                for (let i = 0; i < node.namedChildCount; i++) {
                    const decl = node.namedChild(i);
                    if (decl && decl.type === 'variable_declarator') {
                        const nameNode = decl.childForFieldName('name');
                        const value = decl.childForFieldName('value');
                        if (nameNode) {
                            // Check if it's an arrow function
                            if (value && value.type === 'arrow_function') {
                                symbols.push({
                                    name: nameNode.text,
                                    kind: 'function',
                                    lineStart: node.startPosition.row + 1,
                                    lineEnd: node.endPosition.row + 1,
                                    signature: getSignature(node),
                                    docstring: getDocstring(node),
                                    content: getContent(node, 2048),
                                    exported: true,
                                });
                            } else {
                                symbols.push({
                                    name: nameNode.text,
                                    kind: 'variable',
                                    lineStart: node.startPosition.row + 1,
                                    lineEnd: node.endPosition.row + 1,
                                    signature: getSignature(node),
                                    content: getContent(node, 1024),
                                    exported: true,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Imports
        if (type === 'import_statement' || type === 'import_declaration') {
            extractImport(node);
        }

        // Calls
        if (type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (funcNode) {
                let calledName = funcNode.text;
                // Simplify member expressions to last two parts
                if (calledName.includes('.')) {
                    const parts = calledName.split('.');
                    calledName = parts.slice(-2).join('.');
                }
                if (!SKIP_CALLS.has(calledName) && calledName.length < 100) {
                    const enclosing = findEnclosingSymbol(node);
                    if (enclosing) {
                        calls.push({
                            callerSymbol: enclosing,
                            calledName,
                            line: node.startPosition.row + 1,
                        });
                    }
                }
            }
        }

        // Recurse
        for (let i = 0; i < node.childCount; i++) {
            walkNode(node.child(i), className);
        }
    }

    function extractImport(node: any) {
        const sourceNode = node.childForFieldName('source') ||
            node.children?.find((c: any) => c.type === 'string' || c.type === 'string_literal');

        if (!sourceNode) {
            // Python: import X
            if (language === 'python') {
                const moduleNode = node.childForFieldName('name') ||
                    node.children?.find((c: any) => c.type === 'dotted_name' || c.type === 'aliased_import');
                if (moduleNode) {
                    imports.push({
                        source: moduleNode.text,
                        names: [],
                        isDefault: true,
                    });
                }
            }
            return;
        }

        const source = sourceNode.text.replace(/['"]/g, '');
        const names: string[] = [];
        let isDefault = false;

        // Look for named imports
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child.type === 'import_clause' || child.type === 'named_imports' || child.type === 'import_specifier') {
                walkImportNames(child, names);
                if (child.type === 'import_clause') {
                    const firstNamed = child.firstNamedChild;
                    if (firstNamed && firstNamed.type === 'identifier') {
                        isDefault = true;
                        names.push(firstNamed.text);
                    }
                }
            }
        }

        if (names.length === 0) isDefault = true;

        imports.push({ source, names, isDefault });
    }

    function walkImportNames(node: any, names: string[]) {
        if (node.type === 'import_specifier') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) names.push(nameNode.text);
            return;
        }
        for (let i = 0; i < node.childCount; i++) {
            walkImportNames(node.child(i), names);
        }
    }

    walkNode(tree.rootNode);

    return { symbols, imports, calls, language };
}

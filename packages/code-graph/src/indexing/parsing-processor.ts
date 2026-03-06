/**
 * Parsing Processor — extracts code symbols from source files using Tree-sitter.
 *
 * Phase 2: Parse each file's AST and create nodes for functions, classes,
 * methods, interfaces, etc. Also creates File→Symbol DEFINES edges.
 */

import type { KnowledgeGraph, NodeLabel, GraphNode } from '../types/index.js';
import type { SymbolTable } from './symbol-table.js';
import { getLanguageFromFilename, getGrammar, type SupportedLanguage } from './language-support.js';

// Tree-sitter is loaded dynamically to avoid bundling issues.
let Parser: any = null;

async function ensureParser(): Promise<any> {
  if (!Parser) {
    const mod = await import('tree-sitter');
    Parser = (mod as any).default ?? mod;
  }
  return Parser;
}

/** Extracted symbol from a parse. */
export interface ExtractedSymbol {
  name: string;
  label: NodeLabel;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  language: SupportedLanguage;
  content?: string;
}

/** Extracted import statement. */
export interface ExtractedImport {
  filePath: string;
  importedName: string;
  importedFrom: string;
  isDefault: boolean;
  isNamespace: boolean;
}

/** Extracted call site. */
export interface ExtractedCall {
  callerFile: string;
  callerName: string;
  calleeName: string;
  line: number;
}

/** Extracted heritage (extends/implements). */
export interface ExtractedHeritage {
  filePath: string;
  childName: string;
  parentName: string;
  type: 'extends' | 'implements';
}

/** Result of parsing a single file. */
export interface ParsedFileResult {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  heritage: ExtractedHeritage[];
}

/**
 * Parse files and create graph nodes + register in symbol table.
 *
 * Uses chunked processing — the caller provides a batch of files with
 * content already loaded. This function parses ASTs, extracts symbols,
 * and wires them into the graph.
 */
export async function parseFiles(
  graph: KnowledgeGraph,
  files: Array<{ path: string; content: string }>,
  symbolTable: SymbolTable,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<ParsedFileResult> {
  const TreeSitter = await ensureParser();

  const allSymbols: ExtractedSymbol[] = [];
  const allImports: ExtractedImport[] = [];
  const allCalls: ExtractedCall[] = [];
  const allHeritage: ExtractedHeritage[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(i + 1, files.length, file.path);

    const language = getLanguageFromFilename(file.path);
    if (!language) continue;

    try {
      const grammar = await getGrammar(language);
      const parser = new TreeSitter();
      parser.setLanguage(grammar);
      const tree = parser.parse(file.content);
      const root = tree.rootNode;

      const extracted = extractFromAST(root, file.path, file.content, language);
      allSymbols.push(...extracted.symbols);
      allImports.push(...extracted.imports);
      allCalls.push(...extracted.calls);
      allHeritage.push(...extracted.heritage);

      // Create graph nodes and register in symbol table
      for (const sym of extracted.symbols) {
        const nodeId = `${sym.label}:${sym.name}:${sym.filePath}`;
        graph.addNode({
          id: nodeId,
          label: sym.label,
          properties: {
            name: sym.name,
            filePath: sym.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine,
            isExported: sym.isExported,
            language: sym.language,
            content: sym.content,
          },
        });

        // File DEFINES Symbol
        graph.addRelationship({
          id: `File:${sym.filePath}_defines_${nodeId}`,
          sourceId: `File:${sym.filePath}`,
          targetId: nodeId,
          type: 'DEFINES',
          confidence: 1.0,
          reason: 'ast-parse',
        });

        symbolTable.register({
          nodeId,
          name: sym.name,
          label: sym.label,
          filePath: sym.filePath,
          isExported: sym.isExported,
        });
      }
    } catch (err) {
      // Skip files that fail to parse
      console.warn(`[code-graph] Failed to parse ${file.path}: ${err}`);
    }
  }

  return {
    symbols: allSymbols,
    imports: allImports,
    calls: allCalls,
    heritage: allHeritage,
  };
}

/**
 * Extract symbols, imports, calls, and heritage from a parsed AST.
 */
function extractFromAST(
  root: any,
  filePath: string,
  content: string,
  language: SupportedLanguage,
): ParsedFileResult {
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const calls: ExtractedCall[] = [];
  const heritage: ExtractedHeritage[] = [];

  // Walk the AST tree
  walkNode(root, null);

  function walkNode(node: any, parentName: string | null) {
    switch (language) {
      case 'typescript':
      case 'javascript':
        extractJS(node, parentName);
        break;
      case 'python':
        extractPython(node, parentName);
        break;
      case 'go':
        extractGo(node, parentName);
        break;
      case 'rust':
        extractRust(node, parentName);
        break;
      case 'java':
        extractJava(node, parentName);
        break;
      case 'c':
      case 'cpp':
        extractC(node, parentName);
        break;
      case 'csharp':
        extractCSharp(node, parentName);
        break;
      case 'php':
        extractPHP(node, parentName);
        break;
    }
  }

  // ── TypeScript / JavaScript ─────────────────────────────────────────

  function extractJS(node: any, parentName: string | null) {
    const type = node.type;

    // Function declarations
    if (type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isExported = isJSExported(node);
        symbols.push({
          name: nameNode.text,
          label: 'Function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported,
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    // Arrow / function expressions assigned to variable
    if (type === 'lexical_declaration' || type === 'variable_declaration') {
      for (const declarator of node.namedChildren) {
        if (declarator.type === 'variable_declarator') {
          const nameNode = declarator.childForFieldName('name');
          const valueNode = declarator.childForFieldName('value');
          if (nameNode && valueNode &&
              (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
            const isExported = isJSExported(node);
            symbols.push({
              name: nameNode.text,
              label: 'Function',
              filePath,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              isExported,
              language,
              content: node.text.slice(0, 500),
            });
          }
        }
      }
    }

    // Class declarations
    if (type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isExported = isJSExported(node);
        symbols.push({
          name: nameNode.text,
          label: 'Class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported,
          language,
          content: node.text.slice(0, 500),
        });

        // Extract heritage (extends, implements)
        const heritageNode = node.childForFieldName('superclass') ??
          node.children.find((c: any) => c.type === 'extends_clause');
        if (heritageNode) {
          const parentText = heritageNode.type === 'extends_clause'
            ? heritageNode.namedChildren[0]?.text
            : heritageNode.text;
          if (parentText) {
            heritage.push({
              filePath,
              childName: nameNode.text,
              parentName: parentText,
              type: 'extends',
            });
          }
        }

        // Interfaces (TypeScript implements)
        const implClause = node.children.find((c: any) => c.type === 'implements_clause');
        if (implClause) {
          for (const child of implClause.namedChildren) {
            heritage.push({
              filePath,
              childName: nameNode.text,
              parentName: child.text,
              type: 'implements',
            });
          }
        }

        // Extract methods inside the class body
        const body = node.childForFieldName('body');
        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === 'method_definition' || member.type === 'public_field_definition') {
              const methName = member.childForFieldName('name');
              if (methName && methName.text !== 'constructor') {
                symbols.push({
                  name: `${nameNode.text}.${methName.text}`,
                  label: 'Method',
                  filePath,
                  startLine: member.startPosition.row + 1,
                  endLine: member.endPosition.row + 1,
                  isExported: isExported,
                  language,
                  content: member.text.slice(0, 500),
                });
              }
            }
          }
        }
      }
    }

    // Interface declarations (TypeScript)
    if (type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Interface',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: isJSExported(node),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    // Type alias declarations (TypeScript)
    if (type === 'type_alias_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'CodeElement',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: isJSExported(node),
          language,
        });
      }
    }

    // Import statements
    if (type === 'import_statement') {
      extractJSImport(node);
    }

    // Call expressions
    if (type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const calleeName = funcNode.text;
        // Find enclosing function/method
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName,
          line: node.startPosition.row + 1,
        });
      }
    }

    // Export statements — handle `export default` and `export { ... }`
    if (type === 'export_statement') {
      const declaration = node.childForFieldName('declaration');
      if (declaration) {
        extractJS(declaration, parentName);
        return; // Don't recurse into children again
      }
    }

    // Recurse children
    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  function isJSExported(node: any): boolean {
    const parent = node.parent;
    if (!parent) return false;
    return parent.type === 'export_statement' || parent.type === 'export_default_declaration';
  }

  function extractJSImport(node: any) {
    const source = node.childForFieldName('source');
    if (!source) return;
    const from = source.text.replace(/['"]/g, '');

    for (const child of node.namedChildren) {
      if (child.type === 'import_clause') {
        for (const spec of child.namedChildren) {
          if (spec.type === 'identifier') {
            imports.push({
              filePath, importedName: spec.text, importedFrom: from,
              isDefault: true, isNamespace: false,
            });
          } else if (spec.type === 'named_imports') {
            for (const named of spec.namedChildren) {
              if (named.type === 'import_specifier') {
                const nameNode = named.childForFieldName('name') || named.namedChildren[0];
                if (nameNode) {
                  imports.push({
                    filePath, importedName: nameNode.text, importedFrom: from,
                    isDefault: false, isNamespace: false,
                  });
                }
              }
            }
          } else if (spec.type === 'namespace_import') {
            const nameNode = spec.namedChildren[0];
            if (nameNode) {
              imports.push({
                filePath, importedName: nameNode.text, importedFrom: from,
                isDefault: false, isNamespace: true,
              });
            }
          }
        }
      }
    }
  }

  // ── Python ──────────────────────────────────────────────────────────

  function extractPython(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isMethod = parentName !== null;
        const fullName = isMethod ? `${parentName}.${nameNode.text}` : nameNode.text;
        symbols.push({
          name: fullName,
          label: isMethod ? 'Method' : 'Function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: !nameNode.text.startsWith('_'),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: !nameNode.text.startsWith('_'),
          language,
          content: node.text.slice(0, 500),
        });

        // Superclass
        const superclass = node.childForFieldName('superclasses');
        if (superclass) {
          for (const arg of superclass.namedChildren) {
            heritage.push({
              filePath,
              childName: nameNode.text,
              parentName: arg.text,
              type: 'extends',
            });
          }
        }

        // Recurse into body with class context
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            extractPython(child, nameNode.text);
          }
          return;
        }
      }
    }

    if (type === 'import_statement' || type === 'import_from_statement') {
      extractPythonImport(node);
    }

    if (type === 'call') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: funcNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      if (child.type !== 'class_definition' || type !== 'class_definition') {
        walkNode(child, parentName);
      }
    }
  }

  function extractPythonImport(node: any) {
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      const from = moduleNode?.text || '';
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name' && child !== moduleNode) {
          imports.push({
            filePath, importedName: child.text, importedFrom: from,
            isDefault: false, isNamespace: false,
          });
        } else if (child.type === 'aliased_import') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            imports.push({
              filePath, importedName: nameNode.text, importedFrom: from,
              isDefault: false, isNamespace: false,
            });
          }
        }
      }
    } else if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name') {
          imports.push({
            filePath, importedName: child.text, importedFrom: child.text,
            isDefault: false, isNamespace: true,
          });
        }
      }
    }
  }

  // ── Go ──────────────────────────────────────────────────────────────

  function extractGo(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isExported = /^[A-Z]/.test(nameNode.text);
        symbols.push({
          name: nameNode.text,
          label: 'Function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported,
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      const receiver = node.childForFieldName('receiver');
      if (nameNode) {
        const receiverType = receiver?.namedChildren[0]?.childForFieldName('type')?.text || '';
        const fullName = receiverType ? `${receiverType}.${nameNode.text}` : nameNode.text;
        symbols.push({
          name: fullName,
          label: 'Method',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: /^[A-Z]/.test(nameNode.text),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'type_declaration') {
      for (const spec of node.namedChildren) {
        if (spec.type === 'type_spec') {
          const nameNode = spec.childForFieldName('name');
          const typeNode = spec.childForFieldName('type');
          if (nameNode) {
            const label: NodeLabel = typeNode?.type === 'interface_type' ? 'Interface' : 'Struct';
            symbols.push({
              name: nameNode.text,
              label,
              filePath,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              isExported: /^[A-Z]/.test(nameNode.text),
              language,
              content: node.text.slice(0, 500),
            });
          }
        }
      }
    }

    if (type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: funcNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  // ── Rust ────────────────────────────────────────────────────────────

  function extractRust(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'function_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isPublic = node.children.some((c: any) => c.type === 'visibility_modifier');
        symbols.push({
          name: parentName ? `${parentName}::${nameNode.text}` : nameNode.text,
          label: 'Function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: isPublic,
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'struct_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Struct',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.type === 'visibility_modifier'),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'trait_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Trait',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.type === 'visibility_modifier'),
          language,
        });
      }
    }

    if (type === 'impl_item') {
      const typeNode = node.childForFieldName('type');
      const traitNode = node.childForFieldName('trait');
      if (typeNode) {
        const implName = traitNode ? `${traitNode.text} for ${typeNode.text}` : typeNode.text;
        symbols.push({
          name: implName,
          label: 'Impl',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: false,
          language,
        });

        if (traitNode) {
          heritage.push({
            filePath,
            childName: typeNode.text,
            parentName: traitNode.text,
            type: 'implements',
          });
        }

        // Recurse with impl context
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            extractRust(child, typeNode.text);
          }
          return;
        }
      }
    }

    if (type === 'enum_item') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Enum',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.type === 'visibility_modifier'),
          language,
        });
      }
    }

    if (type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: funcNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  // ── Java ────────────────────────────────────────────────────────────

  function extractJava(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
          content: node.text.slice(0, 500),
        });

        // extends
        const superclass = node.childForFieldName('superclass');
        if (superclass) {
          heritage.push({
            filePath,
            childName: nameNode.text,
            parentName: superclass.text,
            type: 'extends',
          });
        }

        // implements
        const interfaces = node.childForFieldName('interfaces');
        if (interfaces) {
          for (const child of interfaces.namedChildren) {
            heritage.push({
              filePath,
              childName: nameNode.text,
              parentName: child.text,
              type: 'implements',
            });
          }
        }

        // Recurse into body
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            extractJava(child, nameNode.text);
          }
          return;
        }
      }
    }

    if (type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Interface',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    if (type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode && parentName) {
        symbols.push({
          name: `${parentName}.${nameNode.text}`,
          label: 'Method',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'constructor_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: `${parentName || nameNode.text}.constructor`,
          label: 'Constructor',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'method_invocation') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: nameNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  // ── C / C++ ─────────────────────────────────────────────────────────

  function extractC(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'function_definition') {
      const declarator = node.childForFieldName('declarator');
      const nameNode = declarator?.childForFieldName?.('declarator') || declarator;
      if (nameNode) {
        const name = nameNode.text?.replace(/\(.*$/, '') || nameNode.text;
        symbols.push({
          name,
          label: 'Function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true, // C functions are public by default
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'struct_specifier' || type === 'class_specifier') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: type === 'class_specifier' ? 'Class' : 'Struct',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'enum_specifier') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Enum',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: funcNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  // ── C# ──────────────────────────────────────────────────────────────

  function extractCSharp(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const isPublic = node.children.some((c: any) => c.text === 'public');
        symbols.push({
          name: nameNode.text,
          label: 'Class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: isPublic,
          language,
          content: node.text.slice(0, 500),
        });

        // Heritage: base list
        const baseList = node.children.find((c: any) => c.type === 'base_list');
        if (baseList) {
          for (const base of baseList.namedChildren) {
            if (base.type === 'simple_base_type') {
              const baseName = base.namedChildren[0]?.text;
              if (baseName) {
                heritage.push({
                  filePath,
                  childName: nameNode.text,
                  parentName: baseName,
                  type: 'extends',
                });
              }
            }
          }
        }

        // Recurse into body
        const body = node.childForFieldName('body') ?? node.children.find((c: any) => c.type === 'declaration_list');
        if (body) {
          for (const child of body.namedChildren) {
            extractCSharp(child, nameNode.text);
          }
          return;
        }
      }
    }

    if (type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Interface',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    if (type === 'struct_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Struct',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    if (type === 'enum_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Enum',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    if (type === 'record_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Record',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    if (type === 'delegate_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Delegate',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    if (type === 'namespace_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Namespace',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
        // Recurse into namespace body
        const body = node.childForFieldName('body') ?? node.children.find((c: any) => c.type === 'declaration_list');
        if (body) {
          for (const child of body.namedChildren) {
            extractCSharp(child, nameNode.text);
          }
          return;
        }
      }
    }

    if (type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode && parentName) {
        symbols.push({
          name: `${parentName}.${nameNode.text}`,
          label: 'Method',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'constructor_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: `${parentName || nameNode.text}.constructor`,
          label: 'Constructor',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'property_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode && parentName) {
        symbols.push({
          name: `${parentName}.${nameNode.text}`,
          label: 'Property',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
        });
      }
    }

    // Using directives
    if (type === 'using_directive') {
      const nameNode = node.namedChildren.find((c: any) => c.type === 'qualified_name' || c.type === 'identifier');
      if (nameNode) {
        imports.push({
          filePath,
          importedName: nameNode.text,
          importedFrom: nameNode.text,
          isDefault: false,
          isNamespace: true,
        });
      }
    }

    // Invocations
    if (type === 'invocation_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const calleeName = funcNode.type === 'member_access_expression'
          ? funcNode.childForFieldName('name')?.text || funcNode.text
          : funcNode.text;
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  // ── PHP ─────────────────────────────────────────────────────────────

  function extractPHP(node: any, parentName: string | null) {
    const type = node.type;

    if (type === 'class_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Class',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
          content: node.text.slice(0, 500),
        });

        // Heritage: base_clause (extends)
        const baseClause = node.children.find((c: any) => c.type === 'base_clause');
        if (baseClause) {
          for (const child of baseClause.namedChildren) {
            if (child.type === 'name' || child.type === 'qualified_name') {
              heritage.push({
                filePath,
                childName: nameNode.text,
                parentName: child.text,
                type: 'extends',
              });
            }
          }
        }

        // Heritage: class_interface_clause (implements)
        const implClause = node.children.find((c: any) => c.type === 'class_interface_clause');
        if (implClause) {
          for (const child of implClause.namedChildren) {
            if (child.type === 'name' || child.type === 'qualified_name') {
              heritage.push({
                filePath,
                childName: nameNode.text,
                parentName: child.text,
                type: 'implements',
              });
            }
          }
        }

        // Recurse into body
        const body = node.childForFieldName('body') ?? node.children.find((c: any) => c.type === 'declaration_list');
        if (body) {
          for (const child of body.namedChildren) {
            extractPHP(child, nameNode.text);
          }
          return;
        }
      }
    }

    if (type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Interface',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'trait_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Trait',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'enum_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Enum',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'namespace_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          label: 'Namespace',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
        });
      }
    }

    if (type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        symbols.push({
          name: parentName ? `${parentName}.${nameNode.text}` : nameNode.text,
          label: 'Function',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: true,
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    if (type === 'method_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode && parentName) {
        symbols.push({
          name: `${parentName}.${nameNode.text}`,
          label: 'Method',
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: node.children.some((c: any) => c.text === 'public'),
          language,
          content: node.text.slice(0, 500),
        });
      }
    }

    // Use statements (imports)
    if (type === 'namespace_use_declaration') {
      for (const clause of node.namedChildren) {
        if (clause.type === 'namespace_use_clause') {
          const nameNode = clause.namedChildren.find((c: any) => c.type === 'qualified_name');
          if (nameNode) {
            imports.push({
              filePath,
              importedName: nameNode.text.split('\\').pop() || nameNode.text,
              importedFrom: nameNode.text,
              isDefault: false,
              isNamespace: false,
            });
          }
        }
      }
    }

    // Function calls
    if (type === 'function_call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: funcNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    // Method calls
    if (type === 'member_call_expression' || type === 'nullsafe_member_call_expression' || type === 'scoped_call_expression') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const enclosing = findEnclosingFunction(node);
        calls.push({
          callerFile: filePath,
          callerName: enclosing || '<module>',
          calleeName: nameNode.text,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (const child of node.namedChildren) {
      walkNode(child, parentName);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function findEnclosingFunction(node: any): string | null {
    let current = node.parent;
    while (current) {
      if (current.type === 'function_declaration' ||
          current.type === 'function_definition' ||
          current.type === 'method_declaration' ||
          current.type === 'method_definition' ||
          current.type === 'function_item' ||
          current.type === 'arrow_function') {
        const nameNode = current.childForFieldName('name');
        return nameNode?.text || null;
      }
      current = current.parent;
    }
    return null;
  }

  return { symbols, imports, calls, heritage };
}

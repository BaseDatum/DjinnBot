/**
 * Code Knowledge Graph — visual constants for Sigma.js rendering.
 *
 * Mirrors the GitNexus design: per-label colors + sizes, per-edge-type
 * colors, community palette, and ForceAtlas2 tuning helpers.
 */

// ── Node label type (matches backend NodeLabel) ────────────────────────────

export type CodeNodeLabel =
  | 'File' | 'Folder' | 'Function' | 'Class' | 'Method'
  | 'Interface' | 'CodeElement' | 'Community' | 'Process'
  | 'Struct' | 'Enum' | 'Trait' | 'Impl' | 'Namespace'
  | 'TypeAlias' | 'Constructor' | 'Variable' | 'Decorator'
  | 'Import' | 'Type' | 'Macro' | 'Typedef' | 'Union'
  | 'Const' | 'Static' | 'Property' | 'Record' | 'Delegate'
  | 'Annotation' | 'Template' | 'Module' | 'Package';

// ── Node colours ───────────────────────────────────────────────────────────

export const NODE_COLORS: Record<string, string> = {
  Package:     '#8b5cf6',
  Module:      '#7c3aed',
  Folder:      '#6366f1',
  File:        '#3b82f6',
  Class:       '#f59e0b',
  Function:    '#10b981',
  Method:      '#14b8a6',
  Variable:    '#64748b',
  Interface:   '#ec4899',
  Enum:        '#f97316',
  Decorator:   '#eab308',
  Import:      '#475569',
  Type:        '#a78bfa',
  CodeElement: '#64748b',
  Community:   '#818cf8',
  Process:     '#f43f5e',
  Struct:      '#f59e0b',
  Trait:       '#ec4899',
  Impl:        '#a78bfa',
  Namespace:   '#7c3aed',
  TypeAlias:   '#a78bfa',
  Constructor: '#14b8a6',
  Macro:       '#eab308',
  Typedef:     '#a78bfa',
  Union:       '#f97316',
  Const:       '#64748b',
  Static:      '#64748b',
  Property:    '#14b8a6',
  Record:      '#f59e0b',
  Delegate:    '#ec4899',
  Annotation:  '#eab308',
  Template:    '#a78bfa',
};

// ── Node sizes (visual hierarchy) ──────────────────────────────────────────

export const NODE_SIZES: Record<string, number> = {
  Package:     16,
  Module:      13,
  Folder:      10,
  File:        6,
  Class:       8,
  Function:    4,
  Method:      3,
  Variable:    2,
  Interface:   7,
  Enum:        5,
  Decorator:   2,
  Import:      1.5,
  Type:        3,
  CodeElement: 2,
  Community:   0,   // metadata — hidden
  Process:     0,   // metadata — hidden
  Struct:      7,
  Trait:        7,
  Impl:        5,
  Namespace:   10,
  TypeAlias:   3,
  Constructor: 4,
  Macro:       3,
  Typedef:     3,
  Union:       5,
  Const:       2,
  Static:      2,
  Property:    3,
  Record:      6,
  Delegate:    4,
  Annotation:  2,
  Template:    5,
};

// ── Community colour palette ───────────────────────────────────────────────

const COMMUNITY_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#d946ef', '#ec4899', '#f43f5e',
  '#14b8a6', '#84cc16',
];

export function getCommunityColor(index: number): string {
  return COMMUNITY_COLORS[index % COMMUNITY_COLORS.length];
}

// ── Edge styles ────────────────────────────────────────────────────────────

export type EdgeType =
  | 'CONTAINS' | 'DEFINES' | 'IMPORTS' | 'CALLS'
  | 'EXTENDS' | 'IMPLEMENTS' | 'MEMBER_OF' | 'STEP_IN_PROCESS'
  | 'USES' | 'OVERRIDES' | 'DECORATES';

export const EDGE_STYLES: Record<string, { color: string; size: number; label: string }> = {
  CONTAINS:        { color: '#2d5a3d', size: 0.4, label: 'Contains' },
  DEFINES:         { color: '#0e7490', size: 0.5, label: 'Defines' },
  IMPORTS:         { color: '#1d4ed8', size: 0.6, label: 'Imports' },
  CALLS:           { color: '#7c3aed', size: 0.8, label: 'Calls' },
  EXTENDS:         { color: '#c2410c', size: 1.0, label: 'Extends' },
  IMPLEMENTS:      { color: '#be185d', size: 0.9, label: 'Implements' },
  MEMBER_OF:       { color: '#4a4a5a', size: 0.3, label: 'Member Of' },
  STEP_IN_PROCESS: { color: '#4a4a5a', size: 0.3, label: 'Step In' },
  USES:            { color: '#6366f1', size: 0.6, label: 'Uses' },
  OVERRIDES:       { color: '#c2410c', size: 0.8, label: 'Overrides' },
  DECORATES:       { color: '#eab308', size: 0.5, label: 'Decorates' },
};

/** Labels visible by default (hide metadata + imports). */
export const DEFAULT_VISIBLE_LABELS: CodeNodeLabel[] = [
  'Folder', 'File', 'Class', 'Function', 'Method',
  'Interface', 'Enum', 'Struct', 'Trait', 'Namespace',
  'Constructor', 'Record', 'Delegate', 'Template',
];

/** Edge types visible by default. */
export const DEFAULT_VISIBLE_EDGES: EdgeType[] = [
  'CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS',
];

/** Color palettes and helpers for the memory graph canvas. */

export interface ColorPalette {
  categories: Record<string, string>;
  dimmedNode: string;
  dimmedLink: string;
  normalLink: string;
  highlightLink: string;
  highlightNode: string;
  missingNode: string;
  /** Anchor nodes — referenced via wiki-links but have no backing file */
  anchorNode: string;
  anchorStroke: string;
  sharedRing: string;
  orphanNode: string;
  labelText: string;
  labelBg: string;
  focusRing: string;
  edgeTypeColors: Record<string, string>;
}

export const COLORS_DARK: ColorPalette = {
  categories: {
    decisions: '#ff8b6a',
    lessons: '#7af5e9',
    people: '#ff8ea9',
    projects: '#9ec6ff',
    commitments: '#ffe18d',
    research: '#9bf7bd',
    unresolved: '#ffb363',
    root: '#b4bcd1',
    default: '#9dadc5',
    daily: '#c4b5fd',
    observations: '#67e8f9',
    handoffs: '#fda4af',
    tag: '#94a3b8',
    shared: '#a78bfa',
    inbox: '#86efac',
    patterns: '#f9a8d4',
    preferences: '#fcd34d',
  },
  dimmedNode: 'rgba(67, 85, 108, 0.35)',
  dimmedLink: 'rgba(117, 138, 166, 0.10)',
  normalLink: 'rgba(167, 189, 214, 0.28)',
  highlightLink: 'rgba(239, 247, 255, 0.90)',
  highlightNode: '#f3faff',
  missingNode: '#ffc58b',
  anchorNode: 'rgba(167, 139, 250, 0.25)',
  anchorStroke: '#a78bfa',
  sharedRing: '#a78bfa',
  orphanNode: '#fb923c',
  labelText: '#e2e8f0',
  labelBg: 'rgba(15, 23, 42, 0.88)',
  focusRing: 'rgba(147, 197, 253, 0.6)',
  edgeTypeColors: {
    default: 'rgba(167, 189, 214, 0.28)',
    tag: 'rgba(148, 163, 184, 0.20)',
    reference: 'rgba(99, 200, 255, 0.45)',
    related: 'rgba(134, 239, 172, 0.35)',
    blocks: 'rgba(252, 165, 165, 0.45)',
    blocked_by: 'rgba(252, 165, 165, 0.45)',
  },
};

export const COLORS_LIGHT: ColorPalette = {
  categories: {
    decisions: '#dc5434',
    lessons: '#0d9488',
    people: '#db2777',
    projects: '#2563eb',
    commitments: '#ca8a04',
    research: '#16a34a',
    unresolved: '#ea580c',
    root: '#64748b',
    default: '#475569',
    daily: '#7c3aed',
    observations: '#0891b2',
    handoffs: '#e11d48',
    tag: '#64748b',
    shared: '#8b5cf6',
    inbox: '#16a34a',
    patterns: '#be185d',
    preferences: '#b45309',
  },
  dimmedNode: 'rgba(148, 163, 184, 0.30)',
  dimmedLink: 'rgba(148, 163, 184, 0.10)',
  normalLink: 'rgba(100, 116, 139, 0.22)',
  highlightLink: 'rgba(30, 41, 59, 0.80)',
  highlightNode: '#1e293b',
  missingNode: '#ea580c',
  anchorNode: 'rgba(139, 92, 246, 0.20)',
  anchorStroke: '#8b5cf6',
  sharedRing: '#8b5cf6',
  orphanNode: '#ea580c',
  labelText: '#1e293b',
  labelBg: 'rgba(255, 255, 255, 0.90)',
  focusRing: 'rgba(37, 99, 235, 0.5)',
  edgeTypeColors: {
    default: 'rgba(100, 116, 139, 0.22)',
    tag: 'rgba(100, 116, 139, 0.15)',
    reference: 'rgba(37, 99, 235, 0.40)',
    related: 'rgba(22, 163, 74, 0.35)',
    blocks: 'rgba(220, 38, 38, 0.40)',
    blocked_by: 'rgba(220, 38, 38, 0.40)',
  },
};

export function getCategoryColor(palette: ColorPalette, category: string): string {
  return palette.categories[category] ?? palette.categories.default;
}

export function getEdgeColor(palette: ColorPalette, type: string): string {
  return palette.edgeTypeColors[type] ?? palette.edgeTypeColors.default;
}

/** Node radius based on degree (connection count). */
export function nodeRadius(degree: number): number {
  return 3 + Math.min(8, Math.sqrt(degree + 1) * 1.15);
}

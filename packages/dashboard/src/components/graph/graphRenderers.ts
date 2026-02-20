/**
 * Stable canvas rendering callbacks for ForceGraph2D.
 * All functions read from refs so their identities never change,
 * avoiding expensive shadow-canvas flushes on every render.
 */

import type { MutableRefObject } from 'react';
import type { ColorPalette } from './graphColors';
import { nodeRadius, getCategoryColor, getEdgeColor } from './graphColors';
import type { GraphNode, ForceLink } from './types';

export interface RenderRefs {
  colorsRef: MutableRefObject<ColorPalette>;
  hoveredNodeRef: MutableRefObject<GraphNode | null>;
  selectedNodeRef: MutableRefObject<GraphNode | null>;
  highlightNodesRef: MutableRefObject<Set<string>>;
  highlightLinksRef: MutableRefObject<Set<string>>;
  degreeMapRef: MutableRefObject<Map<string, number>>;
  orphanSetRef: MutableRefObject<Set<string>>;
  showOrphansRef: MutableRefObject<boolean>;
  /** Nodes being dragged — pinned temporarily */
  dragNodeRef: MutableRefObject<GraphNode | null>;
}

function resolveId(x: GraphNode | string): string {
  return typeof x === 'string' ? x : x.id;
}

export function makeNodeCanvasObject(refs: RenderRefs) {
  return function nodeCanvasObject(node: any, ctx: CanvasRenderingContext2D, globalScale: number) {
    const { colorsRef, hoveredNodeRef, selectedNodeRef, highlightNodesRef, orphanSetRef } = refs;
    const c = colorsRef.current;
    const degree = refs.degreeMapRef.current.get(node.id) ?? 0;
    const r = nodeRadius(degree);

    const focus = hoveredNodeRef.current ?? selectedNodeRef.current;
    const isHighlighted = highlightNodesRef.current.has(node.id);
    const isDimmed = !!focus && !isHighlighted;
    const isFocus = focus?.id === node.id;
    const isOrphan = orphanSetRef.current.has(node.id);
    // Anchor nodes are referenced via wiki-links but have no backing file.
    // They are structural graph nodes, not errors.
    const isAnchor = node.missing && (node.type === 'unresolved' || !node.path);

    // --- Fill color ---
    let fill: string;
    if (isFocus) {
      fill = c.highlightNode;
    } else if (isDimmed) {
      fill = c.dimmedNode;
    } else if (isAnchor && !focus) {
      fill = c.anchorNode;
    } else if (isOrphan && !focus) {
      fill = c.orphanNode;
    } else {
      fill = getCategoryColor(c, node.category ?? 'default');
    }

    // --- Draw node circle ---
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();

    // --- Anchor dashed ring (no backing file — structural connection point) ---
    if (isAnchor && !isDimmed) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 1.5, 0, 2 * Math.PI);
      ctx.strokeStyle = c.anchorStroke;
      ctx.lineWidth = 1.2 / globalScale;
      ctx.setLineDash([3 / globalScale, 2 / globalScale]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- Shared vault ring ---
    if (node.isShared && !isAnchor) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 2.5, 0, 2 * Math.PI);
      ctx.strokeStyle = isDimmed ? c.dimmedNode : c.sharedRing;
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    // --- Focus glow ring ---
    if (isFocus) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4 / globalScale, 0, 2 * Math.PI);
      ctx.strokeStyle = c.focusRing;
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // --- Label ---
    // Use a constant screen-pixel size so labels never blow up when zoomed in.
    // Target: ~11px on screen regardless of zoom level.
    const LABEL_SCREEN_PX = 11;
    const fontSize = LABEL_SCREEN_PX / globalScale;

    const alwaysShow = isFocus || (isHighlighted && !!focus);
    const showAtZoom = !isDimmed && globalScale >= 1.8;
    if (!alwaysShow && !showAtZoom) return;

    const label = (node.title as string) || node.id;
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const gap = 2 / globalScale;
    const textY = node.y + r + gap;
    const textWidth = ctx.measureText(label).width;
    const pad = 2 / globalScale;
    const br = 3 / globalScale;

    // Background pill for readability
    if (alwaysShow) {
      ctx.fillStyle = c.labelBg;
      ctx.beginPath();
      const bx = node.x - textWidth / 2 - pad;
      const by = textY - pad;
      const bw = textWidth + pad * 2;
      const bh = fontSize + pad * 2;
      ctx.moveTo(bx + br, by);
      ctx.lineTo(bx + bw - br, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + br, br);
      ctx.lineTo(bx + bw, by + bh - br);
      ctx.arcTo(bx + bw, by + bh, bx + bw - br, by + bh, br);
      ctx.lineTo(bx + br, by + bh);
      ctx.arcTo(bx, by + bh, bx, by + bh - br, br);
      ctx.lineTo(bx, by + br);
      ctx.arcTo(bx, by, bx + br, by, br);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = isDimmed ? c.dimmedNode : c.labelText;
    ctx.fillText(label, node.x, textY);
  };
}

export function makeNodePointerAreaPaint(refs: Pick<RenderRefs, 'degreeMapRef'>) {
  return function nodePointerAreaPaint(node: any, color: string, ctx: CanvasRenderingContext2D, _globalScale: number) {
    const degree = refs.degreeMapRef.current.get(node.id) ?? 0;
    const r = nodeRadius(degree);
    // Use fillRect — NOT arc — because arc edges are anti-aliased.
    // Anti-aliased fringe pixels have blended colors that don't match the
    // node's assigned index color, so the library's pixel-lookup fails and
    // hover flickers at the edges.  fillRect produces crisp pixel boundaries.
    // Generous padding (+6 graph-units each side) so the clickable area
    // comfortably encloses the visual circle.
    const pad = 6;
    const side = (r + pad) * 2;
    ctx.fillStyle = color;
    ctx.fillRect(node.x - side / 2, node.y - side / 2, side, side);
  };
}

export function makeLinkColor(refs: Pick<RenderRefs, 'colorsRef' | 'hoveredNodeRef' | 'selectedNodeRef' | 'highlightLinksRef'>) {
  return function linkColor(link: any): string {
    const c = refs.colorsRef.current;
    const sid = resolveId(link.source);
    const tid = resolveId(link.target);
    const key = `${sid}-${tid}`;
    if (refs.highlightLinksRef.current.has(key)) return c.highlightLink;
    if (refs.hoveredNodeRef.current ?? refs.selectedNodeRef.current) return c.dimmedLink;
    return getEdgeColor(c, link.type ?? 'default');
  };
}

export function makeLinkWidth(refs: Pick<RenderRefs, 'highlightLinksRef'>) {
  // Note: when linkCanvasObjectMode returns 'replace', ForceGraph2D does not use
  // this for rendering, but it still affects the link hit area. Return thin
  // constant values — the actual drawing happens in makeLinkCanvasObject.
  return function linkWidth(link: any): number {
    const sid = resolveId(link.source);
    const tid = resolveId(link.target);
    return refs.highlightLinksRef.current.has(`${sid}-${tid}`) ? 2.2 : 0.8;
  };
}

/** Draw directional arrow + optional edge label on highlighted links. */
export function makeLinkCanvasObject(refs: Pick<RenderRefs, 'colorsRef' | 'hoveredNodeRef' | 'selectedNodeRef' | 'highlightLinksRef' | 'degreeMapRef'>) {
  return function linkCanvasObject(link: any, ctx: CanvasRenderingContext2D, globalScale: number) {
    const c = refs.colorsRef.current;
    const sid = resolveId(link.source);
    const tid = resolveId(link.target);
    const key = `${sid}-${tid}`;
    const isHighlighted = refs.highlightLinksRef.current.has(key);
    const hasFocus = !!(refs.hoveredNodeRef.current ?? refs.selectedNodeRef.current);

    const sx = link.source?.x ?? 0;
    const sy = link.source?.y ?? 0;
    const tx = link.target?.x ?? 0;
    const ty = link.target?.y ?? 0;

    const color = isHighlighted
      ? c.highlightLink
      : hasFocus
      ? c.dimmedLink
      : getEdgeColor(c, link.type ?? 'default');

    // Draw line
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = color;
    ctx.lineWidth = isHighlighted ? 2.2 / globalScale : 0.8 / globalScale;
    if (link.type === 'tag') {
      ctx.setLineDash([3, 4]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (!isHighlighted) return;

    // Arrowhead toward target — constant screen size
    const angle = Math.atan2(ty - sy, tx - sx);
    const targetR = nodeRadius(refs.degreeMapRef.current.get(tid) ?? 0);
    const ax = tx - Math.cos(angle) * (targetR + 3 / globalScale);
    const ay = ty - Math.sin(angle) * (targetR + 3 / globalScale);
    const arrowLen = 6 / globalScale;
    const arrowAngle = Math.PI / 6;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - arrowLen * Math.cos(angle - arrowAngle), ay - arrowLen * Math.sin(angle - arrowAngle));
    ctx.lineTo(ax - arrowLen * Math.cos(angle + arrowAngle), ay - arrowLen * Math.sin(angle + arrowAngle));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Edge type label at midpoint — constant screen size
    const label = link.label ?? link.type;
    if (label && label !== 'default' && globalScale > 0.8) {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const fontSize = 9 / globalScale;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      const px = 2 / globalScale;
      const py = 1 / globalScale;
      ctx.fillStyle = c.labelBg;
      ctx.fillRect(mx - tw / 2 - px, my - fontSize / 2 - py, tw + px * 2, fontSize + py * 2);
      ctx.fillStyle = c.labelText;
      ctx.fillText(label, mx, my);
    }
  };
}

/** Rebuild highlight sets from current hover/select state. */
export function syncHighlights(
  refs: Pick<RenderRefs, 'hoveredNodeRef' | 'selectedNodeRef' | 'highlightNodesRef' | 'highlightLinksRef'>,
  getLinks: () => ForceLink[]
) {
  const focus = refs.hoveredNodeRef.current ?? refs.selectedNodeRef.current;
  const nextNodes = new Set<string>();
  const nextLinks = new Set<string>();

  if (focus) {
    nextNodes.add(focus.id);
    for (const link of getLinks()) {
      const sid = resolveId(link.source);
      const tid = resolveId(link.target);
      if (sid === focus.id) {
        nextNodes.add(tid);
        nextLinks.add(`${sid}-${tid}`);
      } else if (tid === focus.id) {
        nextNodes.add(sid);
        nextLinks.add(`${sid}-${tid}`);
      }
    }
  }

  refs.highlightNodesRef.current = nextNodes;
  refs.highlightLinksRef.current = nextLinks;
}

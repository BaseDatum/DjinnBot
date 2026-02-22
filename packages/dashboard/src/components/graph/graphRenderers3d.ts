/**
 * Three.js rendering factories for ForceGraph3D.
 *
 * Provides node and link object generators that map memory types, categories,
 * and interaction state (hover, select, dimmed) to Three.js meshes.
 *
 * Design goals:
 *  - Category → color (reuses graphColors palette)
 *  - Memory type → geometry (octahedron for decisions, cube for facts, etc.)
 *  - Degree → size
 *  - Shared vault nodes → glowing ring
 *  - Anchor/missing nodes → wireframe
 *  - Highlighted nodes → emissive glow
 *  - Labels rendered as sprites that face the camera
 */

import * as THREE from 'three';
import type { MutableRefObject } from 'react';
import type { ColorPalette } from './graphColors';
import { nodeRadius, getCategoryColor, getEdgeColor } from './graphColors';
import type { GraphNode, ForceLink, ZAxisMode } from './types';

// ── Refs shared with the interaction layer ─────────────────────────────────

export interface Render3DRefs {
  colorsRef: MutableRefObject<ColorPalette>;
  hoveredNodeRef: MutableRefObject<GraphNode | null>;
  selectedNodeRef: MutableRefObject<GraphNode | null>;
  highlightNodesRef: MutableRefObject<Set<string>>;
  highlightLinksRef: MutableRefObject<Set<string>>;
  degreeMapRef: MutableRefObject<Map<string, number>>;
  orphanSetRef: MutableRefObject<Set<string>>;
  showOrphansRef: MutableRefObject<boolean>;
}

// ── Geometry cache (one instance per type, reused across all nodes) ────────

const geoCache = new Map<string, THREE.BufferGeometry>();

function getGeometry(memoryType: string): THREE.BufferGeometry {
  if (geoCache.has(memoryType)) return geoCache.get(memoryType)!;

  let geo: THREE.BufferGeometry;
  switch (memoryType) {
    case 'decision':
      geo = new THREE.OctahedronGeometry(1, 0);
      break;
    case 'lesson':
      geo = new THREE.IcosahedronGeometry(1, 1);
      break;
    case 'fact':
      geo = new THREE.BoxGeometry(1.4, 1.4, 1.4);
      break;
    case 'commitment':
      geo = new THREE.TorusGeometry(0.8, 0.3, 8, 16);
      break;
    case 'project':
      geo = new THREE.DodecahedronGeometry(1, 0);
      break;
    case 'preference':
      geo = new THREE.ConeGeometry(0.8, 1.6, 8);
      break;
    case 'feeling':
      geo = new THREE.SphereGeometry(1, 16, 12);
      break;
    case 'relationship':
      geo = new THREE.SphereGeometry(1, 12, 8);
      break;
    default:
      // Default: smooth sphere
      geo = new THREE.SphereGeometry(1, 16, 12);
      break;
  }

  geoCache.set(memoryType, geo);
  return geo;
}

// ── Label sprite factory ───────────────────────────────────────────────────

function createLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 48;
  const font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;

  const pad = 16;
  canvas.width = Math.ceil(textWidth + pad * 2);
  canvas.height = Math.ceil(fontSize * 1.4 + pad * 2);

  // Background pill
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  const r = 8;
  const w = canvas.width;
  const h = canvas.height;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(w - r, 0);
  ctx.arcTo(w, 0, w, r, r);
  ctx.lineTo(w, h - r);
  ctx.arcTo(w, h, w - r, h, r);
  ctx.lineTo(r, h);
  ctx.arcTo(0, h, 0, h - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fill();

  // Text
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  // Scale to reasonable world units
  const aspect = canvas.width / canvas.height;
  const scale = 4;
  sprite.scale.set(scale * aspect, scale, 1);
  return sprite;
}

// ── Shared ring geometry for shared-vault indicator ────────────────────────

const ringGeo = new THREE.TorusGeometry(1, 0.08, 8, 32);

// ── Main node object factory ───────────────────────────────────────────────

export function makeNodeThreeObject(refs: Render3DRefs) {
  return function nodeThreeObject(node: any): THREE.Object3D {
    const c = refs.colorsRef.current;
    const degree = refs.degreeMapRef.current.get(node.id) ?? 0;
    const r = nodeRadius(degree) * 0.45; // Scale down for 3D (units are larger)

    const focus = refs.hoveredNodeRef.current ?? refs.selectedNodeRef.current;
    const isHighlighted = refs.highlightNodesRef.current.has(node.id);
    const isDimmed = !!focus && !isHighlighted;
    const isFocus = focus?.id === node.id;
    const isOrphan = refs.orphanSetRef.current.has(node.id);
    const isAnchor = node.missing && (node.type === 'unresolved' || !node.path);

    // Determine fill color
    let fillHex: string;
    if (isFocus) {
      fillHex = c.highlightNode;
    } else if (isDimmed) {
      fillHex = c.dimmedNode;
    } else if (isAnchor && !focus) {
      fillHex = c.anchorStroke;
    } else if (isOrphan && !focus) {
      fillHex = c.orphanNode;
    } else {
      fillHex = getCategoryColor(c, node.category ?? 'default');
    }

    const color = new THREE.Color(fillHex);
    const group = new THREE.Group();

    // ── Main mesh ──────────────────────────────────────────────────────
    const geo = getGeometry(node.type ?? 'default');
    const matOpts: THREE.MeshLambertMaterialParameters = {
      color,
      transparent: isDimmed || isAnchor,
      opacity: isDimmed ? 0.25 : isAnchor ? 0.4 : 1,
    };

    if (isAnchor) {
      // Wireframe for anchor nodes
      const wireMat = new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
      });
      const mesh = new THREE.Mesh(geo, wireMat);
      mesh.scale.setScalar(r);
      group.add(mesh);
    } else {
      const mat = new THREE.MeshLambertMaterial(matOpts);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(r);
      group.add(mesh);
    }

    // ── Emissive glow for focus node ───────────────────────────────────
    if (isFocus) {
      const glowMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2,
      });
      const glowGeo = new THREE.SphereGeometry(1, 16, 12);
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.scale.setScalar(r * 1.8);
      group.add(glow);
    }

    // ── Shared vault ring ──────────────────────────────────────────────
    if (node.isShared && !isAnchor) {
      const ringColor = isDimmed ? new THREE.Color(c.dimmedNode) : new THREE.Color(c.sharedRing);
      const ringMat = new THREE.MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: isDimmed ? 0.15 : 0.7,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.scale.setScalar(r * 1.5);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    }

    // ── Label sprite (shown for focus + highlighted nodes, or all when
    //    the scene is zoomed in — but we can't check camera distance in
    //    the factory, so show labels for non-dimmed nodes) ──────────────
    const showLabel = isFocus || (isHighlighted && !!focus);
    if (showLabel) {
      const label = node.title || node.id;
      const labelColor = isDimmed ? c.dimmedNode : c.labelText;
      const sprite = createLabelSprite(label, labelColor);
      sprite.position.set(0, r + 3, 0);
      group.add(sprite);
    }

    return group;
  };
}

// ── Link color factory ─────────────────────────────────────────────────────

function resolveId(x: GraphNode | string): string {
  return typeof x === 'string' ? x : x.id;
}

export function makeLinkColor3D(
  refs: Pick<Render3DRefs, 'colorsRef' | 'hoveredNodeRef' | 'selectedNodeRef' | 'highlightLinksRef'>
) {
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

export function makeLinkWidth3D(refs: Pick<Render3DRefs, 'highlightLinksRef'>) {
  return function linkWidth(link: any): number {
    const sid = resolveId(link.source);
    const tid = resolveId(link.target);
    return refs.highlightLinksRef.current.has(`${sid}-${tid}`) ? 2.5 : 0.8;
  };
}

// ── Link directional particles ─────────────────────────────────────────────

export function makeLinkParticles(refs: Pick<Render3DRefs, 'highlightLinksRef'>) {
  return function linkDirectionalParticles(link: any): number {
    const sid = resolveId(link.source);
    const tid = resolveId(link.target);
    return refs.highlightLinksRef.current.has(`${sid}-${tid}`) ? 4 : 0;
  };
}

export function makeLinkParticleWidth(refs: Pick<Render3DRefs, 'highlightLinksRef'>) {
  return function linkDirectionalParticleWidth(link: any): number {
    const sid = resolveId(link.source);
    const tid = resolveId(link.target);
    return refs.highlightLinksRef.current.has(`${sid}-${tid}`) ? 2 : 0;
  };
}

// ── Highlight sync (same logic as 2D) ──────────────────────────────────────

export function syncHighlights3D(
  refs: Pick<Render3DRefs, 'hoveredNodeRef' | 'selectedNodeRef' | 'highlightNodesRef' | 'highlightLinksRef'>,
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

// ── Z-axis constraint helpers ──────────────────────────────────────────────

/** Memory type → Z layer index for "type" Z-axis mode. */
const TYPE_Z_LAYERS: Record<string, number> = {
  decision: 3,
  lesson: 2,
  fact: 1,
  commitment: 0,
  project: -1,
  relationship: -2,
  preference: -3,
  feeling: -4,
};

const TYPE_Z_SPACING = 30;
const VAULT_Z_SPACING = 40;

/**
 * Compute the fixed Z position for a node under a given Z-axis mode.
 * Returns `null` for 'force' mode (let physics decide).
 */
export function computeNodeFz(
  node: GraphNode,
  mode: ZAxisMode,
  timeRange?: { min: number; max: number }
): number | null {
  switch (mode) {
    case 'force':
      return null; // Free physics
    case 'vault':
      return node.isShared ? VAULT_Z_SPACING : -VAULT_Z_SPACING;
    case 'type': {
      const layer = TYPE_Z_LAYERS[node.type] ?? 0;
      return layer * TYPE_Z_SPACING;
    }
    case 'time': {
      if (!node.createdAt || !timeRange) return 0;
      const { min, max } = timeRange;
      const range = max - min || 1;
      // Normalize to [-100, 100]
      return ((node.createdAt - min) / range) * 200 - 100;
    }
    default:
      return null;
  }
}

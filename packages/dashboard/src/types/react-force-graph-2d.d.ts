declare module 'react-force-graph-2d' {
  import { Component } from 'react';
  
  interface ForceGraphProps {
    graphData?: { nodes: any[]; links: any[] };
    nodeId?: string;
    linkSource?: string;
    linkTarget?: string;
    width?: number;
    height?: number;
    backgroundColor?: string;
    nodeRelSize?: number;
    nodeCanvasObject?: (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => void;
    nodeCanvasObjectMode?: () => string;
    nodePointerAreaPaint?: (node: any, color: string, ctx: CanvasRenderingContext2D) => void;
    linkColor?: string | ((link: any) => string);
    linkWidth?: number | ((link: any) => number);
    linkDirectionalParticles?: number;
    onNodeHover?: (node: any | null) => void;
    onNodeClick?: (node: any) => void;
    onBackgroundClick?: () => void;
    d3AlphaDecay?: number;
    d3VelocityDecay?: number;
    cooldownTicks?: number;
    ref?: any;
  }
  
  const ForceGraph2D: React.ForwardRefExoticComponent<ForceGraphProps & React.RefAttributes<any>>;
  export default ForceGraph2D;
  export type ForceGraphMethods = {
    zoomToFit: (durationMs?: number, padding?: number) => void;
    centerAt: (x: number, y: number, durationMs?: number) => void;
    zoom: (zoom: number, durationMs?: number) => void;
    d3ReheatSimulation: () => void;
    refresh: () => void;
  };
}

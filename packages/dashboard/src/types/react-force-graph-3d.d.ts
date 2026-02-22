declare module 'react-force-graph-3d' {
  import type { Component } from 'react';
  import type { Object3D, Scene, WebGLRenderer, Camera } from 'three';

  interface ForceGraph3DProps {
    // Data
    graphData?: { nodes: any[]; links: any[] };
    nodeId?: string;
    linkSource?: string;
    linkTarget?: string;

    // Container
    width?: number;
    height?: number;
    backgroundColor?: string;
    showNavInfo?: boolean;

    // Node styling
    nodeRelSize?: number;
    nodeVal?: number | string | ((node: any) => number);
    nodeLabel?: string | ((node: any) => string);
    nodeColor?: string | ((node: any) => string);
    nodeAutoColorBy?: string | ((node: any) => string | null);
    nodeOpacity?: number;
    nodeResolution?: number;
    nodeThreeObject?: ((node: any) => Object3D) | Object3D | string;
    nodeThreeObjectExtend?: boolean | string | ((node: any) => boolean);

    // Link styling
    linkColor?: string | ((link: any) => string);
    linkWidth?: number | ((link: any) => number);
    linkOpacity?: number;
    linkResolution?: number;
    linkDirectionalParticles?: number | string | ((link: any) => number);
    linkDirectionalParticleWidth?: number | ((link: any) => number);
    linkDirectionalParticleSpeed?: number | ((link: any) => number);
    linkDirectionalParticleColor?: string | ((link: any) => string);
    linkDirectionalArrowLength?: number | string | ((link: any) => number);
    linkDirectionalArrowRelPos?: number | string | ((link: any) => number);
    linkDirectionalArrowColor?: string | ((link: any) => string);
    linkThreeObject?: ((link: any) => Object3D) | Object3D | string;
    linkThreeObjectExtend?: boolean | string | ((link: any) => boolean);
    linkLabel?: string | ((link: any) => string);
    linkCurvature?: number | string | ((link: any) => number);

    // Force engine
    numDimensions?: 1 | 2 | 3;
    forceEngine?: 'd3' | 'ngraph';
    dagMode?: string;
    dagLevelDistance?: number;
    d3AlphaMin?: number;
    d3AlphaDecay?: number;
    d3VelocityDecay?: number;
    warmupTicks?: number;
    cooldownTicks?: number;
    cooldownTime?: number;

    // Interaction
    onNodeClick?: (node: any, event: MouseEvent) => void;
    onNodeRightClick?: (node: any, event: MouseEvent) => void;
    onNodeHover?: (node: any | null, previousNode: any | null) => void;
    onNodeDrag?: (node: any, translate: { x: number; y: number; z: number }) => void;
    onNodeDragEnd?: (node: any, translate: { x: number; y: number; z: number }) => void;
    onLinkClick?: (link: any, event: MouseEvent) => void;
    onLinkRightClick?: (link: any, event: MouseEvent) => void;
    onLinkHover?: (link: any | null, previousLink: any | null) => void;
    onBackgroundClick?: (event: MouseEvent) => void;
    onBackgroundRightClick?: (event: MouseEvent) => void;
    enableNodeDrag?: boolean;
    enableNavigationControls?: boolean;
    controlType?: 'trackball' | 'orbit' | 'fly';

    // Render control
    rendererConfig?: Record<string, any>;
    extraRenderers?: any[];

    ref?: any;
  }

  export type ForceGraph3DMethods = {
    // Camera
    cameraPosition: (
      position?: { x?: number; y?: number; z?: number },
      lookAt?: { x: number; y: number; z: number },
      transitionMs?: number
    ) => { x: number; y: number; z: number };
    // Zoom
    zoomToFit: (durationMs?: number, padding?: number, nodeFilterFn?: (node: any) => boolean) => void;
    // Force engine
    d3Force: (forceName: string, forceFn?: any) => any;
    d3ReheatSimulation: () => void;
    // Scene access
    scene: () => Scene;
    renderer: () => WebGLRenderer;
    camera: () => Camera;
    controls: () => any;
    // Data
    graphData: (data?: { nodes: any[]; links: any[] }) => { nodes: any[]; links: any[] };
    // Utils
    refresh: () => void;
    getGraphBbox: (nodeFilterFn?: (node: any) => boolean) => {
      x: [number, number];
      y: [number, number];
      z: [number, number];
    };
    screen2GraphCoords: (x: number, y: number) => { x: number; y: number; z: number };
    graph2ScreenCoords: (x: number, y: number, z: number) => { x: number; y: number };
  };

  const ForceGraph3D: React.ForwardRefExoticComponent<ForceGraph3DProps & React.RefAttributes<ForceGraph3DMethods>>;
  export default ForceGraph3D;
}

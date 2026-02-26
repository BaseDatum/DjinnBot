/**
 * Type stubs for sigma.js ecosystem packages that may lack declarations.
 * These are minimal — just enough for our useSigma hook to compile.
 */

declare module 'graphology-layout-forceatlas2/worker' {
  import Graph from 'graphology';
  interface FA2LayoutOptions {
    settings?: Record<string, unknown>;
  }
  export default class FA2Layout {
    constructor(graph: Graph, options?: FA2LayoutOptions);
    start(): void;
    stop(): void;
    kill(): void;
    isRunning(): boolean;
  }
}

declare module 'graphology-layout-forceatlas2' {
  import Graph from 'graphology';
  function forceAtlas2(graph: Graph, options?: Record<string, unknown>): void;
  namespace forceAtlas2 {
    function inferSettings(graph: Graph): Record<string, unknown>;
  }
  export default forceAtlas2;
}

declare module 'graphology-layout-noverlap' {
  import Graph from 'graphology';
  function noverlap(graph: Graph, options?: Record<string, unknown>): void;
  namespace noverlap {
    function assign(graph: Graph, options?: Record<string, unknown>): void;
  }
  export default noverlap;
}

declare module '@sigma/edge-curve' {
  const EdgeCurveProgram: any;
  export default EdgeCurveProgram;
}

/**
 * MemoryGraphContainer — wraps MemoryGraph (2D) and MemoryGraph3D with a
 * dimension toggle. Lazy-loads the 3D component so Three.js is only
 * downloaded when the user opts in.
 */

import { lazy, Suspense, useState } from 'react';
import { MemoryGraph } from './MemoryGraph';
import type { GraphDimension } from './graph/types';

const MemoryGraph3D = lazy(() =>
  import('./MemoryGraph3D').then((m) => ({ default: m.MemoryGraph3D }))
);

interface MemoryGraphContainerProps {
  agentId: string;
  hideViewMode?: boolean;
}

export function MemoryGraphContainer({ agentId, hideViewMode }: MemoryGraphContainerProps) {
  const [dimension, setDimension] = useState<GraphDimension>('3d');

  if (dimension === '3d') {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Loading 3D graph…
          </div>
        }
      >
        <MemoryGraph3D
          agentId={agentId}
          hideViewMode={hideViewMode}
          onSwitchTo2D={() => setDimension('2d')}
        />
      </Suspense>
    );
  }

  return (
    <MemoryGraph
      agentId={agentId}
      hideViewMode={hideViewMode}
      onSwitchTo3D={() => setDimension('3d')}
    />
  );
}

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { X, Brain } from 'lucide-react';
import type { Pipeline } from './types';

interface PlanDialogProps {
  pipelines: Pipeline[];
  onClose: () => void;
  onPlan: (pipelineId: string, context: string) => void;
  planning: boolean;
}

export function PlanDialog({
  pipelines,
  onClose,
  onPlan,
  planning,
}: PlanDialogProps) {
  const [planPipelineId, setPlanPipelineId] = useState('planning');
  const [planContext, setPlanContext] = useState('');

  const handleSubmit = () => {
    onPlan(planPipelineId, planContext);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-lg">
        <div className="bg-card border rounded-lg shadow-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              <h3 className="font-semibold">Plan Project with AI</h3>
            </div>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          
          <div className="p-5 space-y-4">
            <p className="text-sm text-muted-foreground">
              AI agents will analyze your project and create a task breakdown with dependencies, priorities, and time estimates.
            </p>
            
            <div>
              <label className="block text-sm font-medium mb-1.5">Planning Pipeline</label>
              <select
                value={planPipelineId}
                onChange={(e) => setPlanPipelineId(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {pipelines.map((p: Pipeline) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                ))}
                {pipelines.length === 0 && (
                  <option value="planning">Planning Pipeline (planning)</option>
                )}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Choose which pipeline agents will use to decompose the project
              </p>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-1.5">Additional Context</label>
              <textarea
                value={planContext}
                onChange={(e) => setPlanContext(e.target.value)}
                placeholder="Tech stack preferences, constraints, existing codebase details, specific requirements..."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y h-28"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Help the AI understand your project better (optional)
              </p>
            </div>
          </div>
          
          <div className="flex justify-end gap-2 px-5 py-4 border-t bg-muted/30 rounded-b-lg">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={planning} className="gap-1.5">
              <Brain className="h-3.5 w-3.5" />
              {planning ? 'Starting...' : 'Start Planning'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

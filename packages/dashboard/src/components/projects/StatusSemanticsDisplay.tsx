import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import type { StatusSemantics } from './types';

interface StatusSemanticsDisplayProps {
  semantics: StatusSemantics;
}

const SEMANTIC_LABELS: Record<keyof StatusSemantics, string> = {
  initial: 'Initial',
  terminal_done: 'Terminal (Done)',
  terminal_fail: 'Terminal (Fail)',
  blocked: 'Blocked',
  in_progress: 'In Progress',
  claimable: 'Claimable',
};

export function StatusSemanticsDisplay({ semantics }: StatusSemanticsDisplayProps) {
  return (
    <div>
      <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Status Semantics
      </Label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
        {(Object.entries(semantics) as [keyof StatusSemantics, string[]][]).map(
          ([key, values]) => (
            <div key={key} className="p-2 rounded bg-muted/30">
              <span className="text-[10px] font-medium text-muted-foreground">
                {SEMANTIC_LABELS[key] ?? key}
              </span>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {values.map((v) => (
                  <Badge key={v} variant="outline" className="text-[9px] font-mono">
                    {v}
                  </Badge>
                ))}
                {values.length === 0 && (
                  <span className="text-[9px] text-muted-foreground italic">none</span>
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

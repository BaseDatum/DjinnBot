import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, Columns3, Sparkles, Plus } from 'lucide-react';
import { fetchProjectTemplates, type ProjectTemplate } from '@/lib/api';

interface TemplatePickerProps {
  onSelect: (template: ProjectTemplate | null) => void;
  selected: ProjectTemplate | null;
  /** When true, show only templates with onboarding agent chains */
  onboardingOnly?: boolean;
  /** When true, include a "Custom" option */
  showCustom?: boolean;
  /** Called after templates load with the filtered count */
  onLoad?: (count: number) => void;
}

export function TemplatePicker({ onSelect, selected, onboardingOnly, showCustom = true, onLoad }: TemplatePickerProps) {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProjectTemplates()
      .then((data) => {
        let filtered = data;
        if (onboardingOnly) {
          filtered = data.filter(
            (t) => t.onboardingAgentChain && t.onboardingAgentChain.length > 0
          );
        }
        setTemplates(filtered);
        onLoad?.(filtered.length);
        // Auto-select if only one template available
        if (filtered.length === 1 && !selected) {
          onSelect(filtered[0]);
        }
      })
      .catch(() => {
        onLoad?.(0);
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboardingOnly]);

  if (loading) {
    return (
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton width={24} height={24} className="mb-2" />
            <Skeleton width={120} height={16} className="mb-1" />
            <Skeleton width="100%" height={12} />
          </Card>
        ))}
      </div>
    );
  }

  if (templates.length === 0 && !showCustom) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        No templates with agent-guided onboarding configured.
      </p>
    );
  }

  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
      {templates.map((tmpl) => {
        const isSelected = selected?.id === tmpl.id;
        return (
          <Card
            key={tmpl.id}
            className={`cursor-pointer transition-all hover:border-primary/50 ${
              isSelected
                ? 'border-primary ring-1 ring-primary/30 bg-primary/5'
                : ''
            }`}
            onClick={() => onSelect(isSelected ? null : tmpl)}
          >
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  {tmpl.icon && <span className="text-lg">{tmpl.icon}</span>}
                  <span className="font-medium text-sm">{tmpl.name}</span>
                </div>
                {isSelected && (
                  <Check className="h-4 w-4 text-primary shrink-0" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-2 line-clamp-2">
                {tmpl.description}
              </p>
              {onboardingOnly && tmpl.onboardingAgentChain && tmpl.onboardingAgentChain.length > 0 && (
                <p className="text-[10px] text-muted-foreground mb-2">
                  Guided by: {tmpl.onboardingAgentChain.join(' → ')}
                </p>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Columns3 className="h-2.5 w-2.5" />
                  {tmpl.columns.length} columns
                </Badge>
                {tmpl.onboardingAgentChain && tmpl.onboardingAgentChain.length > 0 && (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    <Sparkles className="h-2.5 w-2.5" />
                    Agent guided
                  </Badge>
                )}
                {tmpl.metadata?.git_integration && (
                  <Badge variant="outline" className="text-[10px]">
                    Git
                  </Badge>
                )}
                {tmpl.isBuiltin && (
                  <Badge variant="secondary" className="text-[10px]">
                    Built-in
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
      {showCustom && (
        <Card
          className={`cursor-pointer transition-all hover:border-primary/50 border-dashed ${
            selected === null && templates.length > 0 ? '' : ''
          }`}
          onClick={() => onSelect(null)}
        >
          <CardContent className="p-4 flex flex-col items-center justify-center text-center min-h-[120px]">
            <Plus className="h-6 w-6 text-muted-foreground mb-2" />
            <span className="text-sm font-medium">Custom Project</span>
            <p className="text-xs text-muted-foreground mt-1">
              Define your own columns and workflow
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

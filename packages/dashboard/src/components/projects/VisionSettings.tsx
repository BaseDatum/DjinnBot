/**
 * VisionSettings — project-level living markdown document that describes
 * the project's goals, architecture, constraints, and current priorities.
 * Agents read this before starting work via the get_project_vision tool.
 */
import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE } from '@/lib/api';
import { authFetch } from '@/lib/auth';

interface VisionSettingsProps {
  projectId: string;
  currentVision: string | null;
  onUpdate: () => void;
}

export function VisionSettings({ projectId, currentVision, onUpdate }: VisionSettingsProps) {
  const [vision, setVision] = useState(currentVision || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVision(currentVision || '');
  }, [currentVision]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/projects/${projectId}/vision`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vision }),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast.success('Project vision updated');
      onUpdate();
    } catch {
      toast.error('Failed to update project vision');
    } finally {
      setSaving(false);
    }
  }, [projectId, vision, onUpdate]);

  const hasChanged = (vision || '') !== (currentVision || '');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4" />
          Project Vision
        </CardTitle>
        <CardDescription>
          A living document that describes this project's goals, architecture, constraints,
          and current priorities. Agents read this before starting work on any task to ensure
          their contributions align with the project's direction. Supports markdown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          className="w-full min-h-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
          placeholder={`# Project Vision\n\n## Goals\n- ...\n\n## Architecture\n- ...\n\n## Current Priorities\n1. ...\n2. ...\n\n## Constraints\n- ...`}
          value={vision}
          onChange={(e) => setVision(e.target.value)}
          rows={12}
        />
        {hasChanged && (
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving} size="sm">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

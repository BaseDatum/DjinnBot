import { useState, useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Columns3, ExternalLink, FileText } from 'lucide-react';
import { fetchProjectTemplate, type ProjectTemplate } from '@/lib/api';
import { StatusSemanticsDisplay } from './StatusSemanticsDisplay';
import type { Project, StatusSemantics } from './types';

interface ProjectSettingsPanelProps {
  project: Project;
}

export function ProjectSettingsPanel({ project }: ProjectSettingsPanelProps) {
  const [template, setTemplate] = useState<ProjectTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  useEffect(() => {
    if (!project.template_id) return;
    setTemplateLoading(true);
    fetchProjectTemplate(project.template_id)
      .then(setTemplate)
      .catch(() => setTemplateError('Failed to load template'))
      .finally(() => setTemplateLoading(false));
  }, [project.template_id]);

  return (
    <div className="space-y-6">
      {/* Template Info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Template</CardTitle>
        </CardHeader>
        <CardContent>
          {templateLoading ? (
            <div className="space-y-2">
              <Skeleton height={20} width={160} />
              <Skeleton height={14} width={240} />
            </div>
          ) : template ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">{template.icon || '📁'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{template.name}</span>
                    {template.isBuiltin && (
                      <Badge variant="secondary" className="text-[10px]">Built-in</Badge>
                    )}
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <Columns3 className="h-2.5 w-2.5" />
                      {template.columns.length} columns
                    </Badge>
                  </div>
                  {template.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {template.description}
                    </p>
                  )}
                </div>
                <Link
                  to="/settings"
                  search={{ tab: 'templates' }}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  Manage
                </Link>
              </div>
            </div>
          ) : templateError ? (
            <p className="text-xs text-destructive">{templateError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No template — this project was created without a template.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Status Semantics */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Status Semantics</CardTitle>
        </CardHeader>
        <CardContent>
          {project.status_semantics ? (
            <StatusSemanticsDisplay semantics={project.status_semantics} />
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Using legacy defaults. This project uses the built-in software development
                status semantics.
              </p>
              <Link
                to="/settings"
                search={{ tab: 'templates' }}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                <FileText className="h-3 w-3" />
                View software-dev template
              </Link>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Column Definitions (read-only) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Column Definitions</CardTitle>
        </CardHeader>
        <CardContent>
          {project.columns.length > 0 ? (
            <div className="space-y-1">
              {project.columns
                .slice()
                .sort((a, b) => a.position - b.position)
                .map((col) => (
                  <div
                    key={col.id}
                    className="flex items-center gap-2 p-2 rounded bg-muted/30 text-xs"
                  >
                    <span className="text-muted-foreground w-5 text-right">
                      {col.position}
                    </span>
                    <span className="font-medium flex-1">{col.name}</span>
                    {col.wip_limit && (
                      <Badge variant="outline" className="text-[9px]">
                        WIP: {col.wip_limit}
                      </Badge>
                    )}
                    <span className="text-muted-foreground font-mono">
                      {col.task_statuses.join(', ')}
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No columns defined.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FolderKanban, ArrowRight, Settings2, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchAgentProjects } from '@/lib/api';
import { RoutineMappingPanel } from '@/components/pulse/RoutineMappingPanel';


interface AgentProjectsTabProps {
  agentId: string;
}

const ROLE_COLORS: Record<string, string> = {
  lead: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  member: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  reviewer: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'text-green-600',
  planning: 'text-amber-600',
  completed: 'text-muted-foreground',
  archived: 'text-muted-foreground',
};

export function AgentProjectsTab({ agentId }: AgentProjectsTabProps) {
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['agentProjects', agentId],
    queryFn: () => fetchAgentProjects(agentId),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        Loading projects...
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
        <FolderKanban className="h-8 w-8 opacity-40" />
        <p className="text-sm">Not assigned to any projects</p>
        <p className="text-xs text-center max-w-xs">
          Assign this agent to a project via the project's Team panel to enable autonomous task execution.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {projects.map((proj: any) => {
        const roleColor = ROLE_COLORS[proj.role] || ROLE_COLORS.member;
        const statusColor = STATUS_COLORS[proj.project_status] || 'text-muted-foreground';
        const isExpanded = expandedProject === proj.project_id;

        return (
          <div
            key={proj.project_id}
            className="rounded-lg border bg-card hover:border-primary/40 transition-colors"
          >
            <div className="flex items-start gap-3 p-3.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 shrink-0 mt-0.5">
                <FolderKanban className="h-4.5 w-4.5 text-primary" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: proj.project_id }}
                    search={{ view: 'board', plan: undefined }}
                    className="font-semibold text-sm hover:text-primary transition-colors truncate"
                  >
                    {proj.project_name}
                  </Link>
                  <Badge
                    variant="outline"
                    className={`text-[10px] capitalize ${roleColor}`}
                  >
                    {proj.role}
                  </Badge>
                  <span className={`text-[10px] capitalize ${statusColor}`}>
                    {proj.project_status}
                  </span>
                </div>

                <div className="mt-1.5 flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs gap-1 text-muted-foreground"
                    onClick={() => setExpandedProject(isExpanded ? null : proj.project_id)}
                  >
                    <Settings2 className="h-3 w-3" />
                    Routine Mappings
                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </Button>
                </div>
              </div>

              <Link
                to="/projects/$projectId"
                params={{ projectId: proj.project_id }}
                search={{ view: 'board', plan: undefined }}
                className="shrink-0 self-center text-muted-foreground hover:text-primary transition-colors"
              >
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            {isExpanded && (
              <RoutineMappingPanel
                projectId={proj.project_id}
                agentId={agentId}
              />
            )}
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground text-center pt-1">
        {projects.length} project{projects.length === 1 ? '' : 's'}
      </p>
    </div>
  );
}




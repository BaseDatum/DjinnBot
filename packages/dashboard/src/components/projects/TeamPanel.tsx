import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { UserPlus, X, Bot, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import {
  fetchProjectAgents,
  assignAgentToProject,
  updateAgentRole,
  removeAgentFromProject,
  fetchAgents,
  fetchAgentLifecycle,
  type ProjectAgent,
} from '@/lib/api';
import styles from './TeamPanel.module.css';

const COLUMN_MAP: Record<string, string> = {
  lead: 'Ready, Review',
  member: 'Ready, In Progress',
  reviewer: 'Review',
};

interface TeamPanelProps {
  projectId: string;
}

function AgentPulseStatus({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: ['lifecycle', agentId],
    queryFn: () => fetchAgentLifecycle(agentId),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const isActive = data?.state === 'working' || data?.state === 'thinking';
  const pulseEnabled = data?.pulse?.enabled ?? false;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={styles.pulseIndicator}>
            <div className={`${styles.pulseDot} ${isActive ? styles.pulseDotActive : ''}`} />
            {pulseEnabled && !isActive && (
              <Zap className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {isActive ? 'Active now' : pulseEnabled ? 'Pulse enabled' : 'Idle'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function TeamPanel({ projectId }: TeamPanelProps) {
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addAgentId, setAddAgentId] = useState('');
  const [addRole, setAddRole] = useState<ProjectAgent['role']>('member');

  const { data: projectAgents = [], isLoading } = useQuery({
    queryKey: ['projectAgents', projectId],
    queryFn: () => fetchProjectAgents(projectId),
  });

  const { data: allAgents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
  });

  const assignMutation = useMutation({
    mutationFn: () => assignAgentToProject(projectId, addAgentId, addRole),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projectAgents', projectId] });
      setShowAdd(false);
      setAddAgentId('');
      setAddRole('member');
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ agentId, role }: { agentId: string; role: ProjectAgent['role'] }) =>
      updateAgentRole(projectId, agentId, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projectAgents', projectId] }),
  });

  const removeMutation = useMutation({
    mutationFn: (agentId: string) => removeAgentFromProject(projectId, agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projectAgents', projectId] }),
  });

  const assignedIds = new Set(projectAgents.map((pa) => pa.agent_id));
  const availableAgents = allAgents.filter((a) => !assignedIds.has(a.id));
  const agentMap = new Map(allAgents.map((a) => [a.id, a]));
  const isAutonomous = projectAgents.length > 0;

  if (isLoading) {
    return (
      <div className={styles.empty}>
        <Bot className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
        Loading team…
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.headerTitle}>Team</span>
          <div
            className={`${styles.autonomousBadge} ${
              isAutonomous ? styles.autonomousBadgeActive : styles.autonomousBadgeInactive
            }`}
          >
            <Bot className="h-3 w-3" />
            {isAutonomous ? 'Autonomous' : 'Manual'}
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => {
            setShowAdd((v) => !v);
            // Reset form when opening
            if (!showAdd) {
              setAddAgentId('');
              setAddRole('member');
              assignMutation.reset();
            }
          }}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Add member
          {showAdd ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </Button>
      </div>

      {/* ── Add-member form ── */}
      {showAdd && (
        <div className={styles.addSection}>
          <span className={styles.addSectionLabel}>Add agent to project</span>

          <div className={styles.addRow}>
            {/* Agent picker — stretches */}
            <div className={styles.addSelect}>
              <Select value={addAgentId} onValueChange={setAddAgentId}>
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue placeholder="Select agent…" />
                </SelectTrigger>
                <SelectContent>
                  {availableAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="mr-1">{a.emoji || '🤖'}</span>
                      {a.name}
                    </SelectItem>
                  ))}
                  {availableAgents.length === 0 && (
                    <SelectItem value="__none__" disabled>
                      All agents already assigned
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Role picker — fixed width */}
            <div className={styles.addRoleSelect}>
              <Select
                value={addRole}
                onValueChange={(v) => setAddRole(v as ProjectAgent['role'])}
              >
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lead">Lead</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="reviewer">Reviewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Error message */}
          {assignMutation.isError && (
            <p className={styles.errorText}>
              {assignMutation.error instanceof Error
                ? assignMutation.error.message
                : 'Failed to add agent. Please try again.'}
            </p>
          )}

          <div className={styles.addActions}>
            <Button
              size="sm"
              className="h-8 text-sm flex-1"
              disabled={!addAgentId || addAgentId === '__none__' || assignMutation.isPending}
              onClick={() => assignMutation.mutate()}
            >
              {assignMutation.isPending ? 'Adding…' : 'Add to project'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-sm"
              onClick={() => {
                setShowAdd(false);
                assignMutation.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Team list / empty state ── */}
      {projectAgents.length === 0 ? (
        <div className={styles.empty}>
          <Bot className="h-8 w-8 mx-auto mb-3 text-muted-foreground/50" />
          <p className="font-medium text-foreground/70 mb-1">No agents assigned</p>
          <p>Add agents to enable autonomous execution.</p>
        </div>
      ) : (
        <div className={styles.teamList}>
          {projectAgents.map((pa) => {
            const agent = agentMap.get(pa.agent_id);
            const defaultCols = COLUMN_MAP[pa.role] || '';
            const isRemoving = removeMutation.isPending && removeMutation.variables === pa.agent_id;

            return (
              <div
                key={pa.agent_id}
                className={`${styles.agentRow} ${isRemoving ? 'opacity-50 pointer-events-none' : ''}`}
              >
                {/* Avatar */}
                <div className={styles.avatar}>{agent?.emoji || '🤖'}</div>

                {/* Name + column chips */}
                <div className={styles.agentInfo}>
                  <div className={styles.agentName}>{agent?.name || pa.agent_id}</div>
                  {defaultCols && (
                    <div className={styles.columns}>
                      {defaultCols.split(', ').map((col) => (
                        <span key={col} className={styles.columnChip}>
                          {col}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Pulse indicator */}
                <AgentPulseStatus agentId={pa.agent_id} />

                {/* Role selector */}
                <Select
                  value={pa.role}
                  onValueChange={(v) =>
                    roleMutation.mutate({ agentId: pa.agent_id, role: v as ProjectAgent['role'] })
                  }
                >
                  <SelectTrigger className={`${styles.roleSelect} h-7 text-xs`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lead">Lead</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="reviewer">Reviewer</SelectItem>
                  </SelectContent>
                </Select>

                {/* Remove button — always visible on touch, hover-only on mouse */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`${styles.removeBtn} h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10`}
                        onClick={() => removeMutation.mutate(pa.agent_id)}
                        aria-label={`Remove ${agent?.name || pa.agent_id}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from project</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

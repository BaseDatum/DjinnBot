/**
 * AgentSkillsTab — V2, access-control based.
 *
 * Shows:
 * - Skills this agent has been granted access to (fetched from agent_skills)
 * - "Browse Library" panel to grant any skill from the library in one click
 * - Revoke button per granted skill
 *
 * No more skillsDisabled in config.yml — access is managed entirely via DB.
 */
import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Plus, Trash2, Globe, User, Loader2, ExternalLink, Sparkles,
  ShieldCheck, ShieldX, Library,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAgentSkills,
  fetchSkills,
  grantSkillToAgent,
  revokeSkillFromAgent,
  type GrantedSkill,
  type Skill,
} from '@/lib/api';

interface AgentSkillsTabProps {
  agentId: string;
}

export function AgentSkillsTab({ agentId }: AgentSkillsTabProps) {
  const [granted, setGranted] = useState<GrantedSkill[]>([]);
  const [library, setLibrary] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLibrary, setShowLibrary] = useState(false);

  const [granting, setGranting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchAgentSkills(agentId), fetchSkills()])
      .then(([g, lib]) => { setGranted(g); setLibrary(lib); })
      .catch(() => toast.error('Failed to load skills'))
      .finally(() => setLoading(false));
  }, [agentId]);

  // Skills from the library not yet granted to this agent
  const grantedIds = useMemo(() => new Set(granted.map(g => g.id)), [granted]);
  const ungrantedLibrary = useMemo(
    () => library.filter(s => !grantedIds.has(s.id) && s.enabled),
    [library, grantedIds],
  );

  const handleGrant = async (skillId: string) => {
    setGranting(skillId);
    try {
      const result = await grantSkillToAgent(agentId, skillId);
      setGranted(prev => [...prev, result]);
      toast.success(`Granted "${skillId}" to ${agentId}`);
    } catch {
      toast.error('Failed to grant skill');
    } finally {
      setGranting(null);
    }
  };

  const handleRevoke = async (skillId: string) => {
    if (!confirm(`Revoke access to "${skillId}" for ${agentId}?`)) return;
    setRevoking(skillId);
    try {
      await revokeSkillFromAgent(agentId, skillId);
      setGranted(prev => prev.filter(g => g.id !== skillId));
      toast.success(`Revoked "${skillId}" from ${agentId}`);
    } catch {
      toast.error('Failed to revoke skill');
    } finally {
      setRevoking(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const globalGranted = granted.filter(g => g.scope === 'global');
  const agentGranted = granted.filter(g => g.scope === 'agent');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Only skills explicitly granted to this agent appear in its manifest and can be loaded via <code className="text-xs bg-muted px-1 rounded">load_skill()</code>.
        </p>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" asChild>
            <a href="/skills" className="flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Skill Library</span>
            </a>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href="/skills/generate" className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Generate</span>
            </a>
          </Button>
          <Button
            size="sm"
            onClick={() => setShowLibrary(v => !v)}
            variant={showLibrary ? 'outline' : 'default'}
          >
            <Library className="h-3.5 w-3.5 mr-1.5" />
            {showLibrary ? 'Hide Library' : 'Browse Library'}
          </Button>
        </div>
      </div>

      {/* Library browser — grant skills */}
      {showLibrary && (
        <Card className="border-primary/30">
          <CardContent className="pt-4 space-y-2">
            <p className="text-xs font-medium text-muted-foreground mb-3">
              Skill Library — click Grant to give {agentId} access
            </p>
            {ungrantedLibrary.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {library.filter(s => s.enabled).length === 0
                  ? 'No skills in the library yet. Create some on the Skill Library page.'
                  : `${agentId} already has access to all enabled skills.`}
              </p>
            ) : (
              ungrantedLibrary.map(skill => (
                <div key={skill.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                  <div className="flex-1 min-w-0 mr-3">
                    <div className="flex items-center gap-2">
                      {skill.scope === 'agent'
                        ? <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        : <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                      <code className="font-mono text-sm font-medium">{skill.id}</code>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{skill.description}</p>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-xs shrink-0"
                    disabled={granting === skill.id}
                    onClick={() => handleGrant(skill.id)}
                  >
                    {granting === skill.id
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <><Plus className="h-3 w-3 mr-1" />Grant</>}
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Granted skills — global */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Global Skills ({globalGranted.length} granted)</h3>
        </div>
        {globalGranted.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">
            No global skills granted. Use "Browse Library" to add some.
          </p>
        ) : (
          <div className="space-y-2">
            {globalGranted.map(skill => (
              <div
                key={skill.id}
                className={`flex items-start gap-3 px-3 py-2 rounded-md border ${skill.enabled ? 'bg-muted/30' : 'bg-muted/10 opacity-60'}`}
              >
                <ShieldCheck className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <code className="font-mono text-sm font-medium shrink-0">{skill.id}</code>
                    <span className="text-sm text-muted-foreground truncate">{skill.description}</span>
                    {!skill.enabled && (
                      <Badge variant="outline" className="text-xs shrink-0">Globally disabled</Badge>
                    )}
                  </div>
                  {skill.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {skill.tags.slice(0, 4).map(t => (
                        <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleRevoke(skill.id)}
                  disabled={revoking === skill.id}
                  title="Revoke access"
                  className="p-1 rounded hover:bg-destructive/10 text-destructive transition-colors shrink-0 mt-0.5"
                >
                  {revoking === skill.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <ShieldX className="h-3.5 w-3.5" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Granted skills — agent-specific */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Agent-Specific Skills ({agentGranted.length})</h3>
          <span className="text-xs text-muted-foreground">Created by or for {agentId}</span>
        </div>
        {agentGranted.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">
            No agent-specific skills. Agents can create these via <code className="text-xs bg-muted px-1 rounded">create_skill(scope="agent")</code>.
          </p>
        ) : (
          <div className="space-y-2">
            {agentGranted.map(skill => (
              <div key={skill.id} className="flex items-start gap-3 px-3 py-2 rounded-md border bg-muted/30">
                <User className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm font-medium">{skill.id}</code>
                    <span className="text-sm text-muted-foreground truncate">{skill.description}</span>
                  </div>
                  {skill.tags.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {skill.tags.map(t => (
                        <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleRevoke(skill.id)}
                  disabled={revoking === skill.id}
                  title="Revoke access"
                  className="p-1 rounded hover:bg-destructive/10 text-destructive transition-colors shrink-0"
                >
                  {revoking === skill.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useRef } from 'react'; // useRef is used by SkillEditForm
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Zap, Plus, Trash2, Edit2, Check, X, ToggleLeft, ToggleRight,
  Loader2, Globe, Sparkles, Clipboard, AlertTriangle,
  Github, FileCode, ChevronDown, ChevronUp, Users, User, ShieldCheck,
  Save,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  fetchSkills,
  fetchAgents,
  fetchAgentSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
  grantSkillToAgent,
  revokeSkillFromAgent,
  parseSkill,
  importGithubSkills,
  type Skill,
  type GrantedSkill,
  type GitHubImportedSkill,
  type GitHubImportResult,
  type AgentListItem,
} from '@/lib/api';

export const Route = createFileRoute('/skills')({
  component: SkillsPage,
});

// ── Access management panel ───────────────────────────────────────────────────

function AccessPanel({
  skill,
  agents,
  onClose,
}: {
  skill: Skill;
  agents: AgentListItem[];
  onClose: () => void;
}) {
  const [grants, setGrants] = useState<GrantedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [granting, setGranting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    // Load current grants for this skill by checking each agent
    // We do this by cross-referencing the agent list against the skill's grant state.
    // For efficiency we load all agents' granted skills in parallel and filter.
    let cancelled = false;
    setLoading(true);
    Promise.all(
      agents.map(a =>
        fetchAgentSkills(a.id)
          .then(agentSkills => agentSkills.filter(s => s.id === skill.id).map(s => ({ ...s, _agentId: a.id })))
          .catch(() => [] as (GrantedSkill & { _agentId: string })[]),
      ),
    ).then(results => {
      if (cancelled) return;
      const found = results.flat();
      setGrants(found as any);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skill.id, agents]);

  const isGranted = (agentId: string) =>
    grants.some((g: any) => g._agentId === agentId);

  const handleGrant = async (agentId: string) => {
    setGranting(agentId);
    try {
      const grant = await grantSkillToAgent(agentId, skill.id);
      setGrants(prev => [...prev.filter((g: any) => g._agentId !== agentId), { ...grant, _agentId: agentId } as any]);
      toast.success(`Granted "${skill.id}" to ${agentId}`);
    } catch {
      toast.error('Failed to grant skill');
    } finally {
      setGranting(null);
    }
  };

  const handleRevoke = async (agentId: string) => {
    setRevoking(agentId);
    try {
      await revokeSkillFromAgent(agentId, skill.id);
      setGrants(prev => prev.filter((g: any) => g._agentId !== agentId));
      toast.success(`Revoked "${skill.id}" from ${agentId}`);
    } catch {
      toast.error('Failed to revoke skill');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="border rounded-lg bg-card p-4 mt-2 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4" />
          Agent Access — <code className="font-mono text-xs bg-muted px-1 rounded">{skill.id}</code>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading...
        </div>
      ) : (
        <div className="space-y-1.5">
          {agents.map(agent => {
            const granted = isGranted(agent.id);
            const busy = granting === agent.id || revoking === agent.id;
            return (
              <div key={agent.id} className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2 text-sm">
                  {agent.emoji && <span>{agent.emoji}</span>}
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{agent.id}</span>
                </div>
                <div className="flex items-center gap-2">
                  {granted && (
                    <Badge variant="secondary" className="text-xs flex items-center gap-1">
                      <ShieldCheck className="h-2.5 w-2.5" /> Access
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant={granted ? 'outline' : 'default'}
                    className="h-6 px-2 text-xs"
                    disabled={busy}
                    onClick={() => granted ? handleRevoke(agent.id) : handleGrant(agent.id)}
                  >
                    {busy
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : granted ? 'Revoke' : 'Grant'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── GitHub skill preview card ─────────────────────────────────────────────────

function GitHubSkillCard({
  skill,
  onSave,
  onDiscard,
}: {
  skill: GitHubImportedSkill;
  onSave: (skill: GitHubImportedSkill) => Promise<void>;
  onDiscard: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(skill);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-green-500/30 bg-green-500/5 text-sm text-green-600 dark:text-green-400">
        <Check className="h-4 w-4 shrink-0" />
        <code className="font-mono font-medium">{skill.name}</code>
        <span className="text-xs text-muted-foreground">saved</span>
      </div>
    );
  }

  return (
    <div className={`rounded-md border bg-card ${!skill.valid ? 'border-destructive/40' : ''}`}>
      <div className="px-3 py-2.5 flex items-start gap-3">
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-0.5 shrink-0 p-0.5 rounded hover:bg-muted transition-colors text-muted-foreground"
          disabled={!skill.content}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1">
            <code className="font-mono font-semibold text-sm">{skill.name || skill.path}</code>
            {skill.name_conflict && (
              <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">will overwrite</Badge>
            )}
            {!skill.valid && (
              <Badge variant="outline" className="text-xs text-destructive border-destructive/30">invalid</Badge>
            )}
          </div>
          {skill.description && <p className="text-xs text-muted-foreground truncate mb-1">{skill.description}</p>}
          {!skill.valid && skill.error && (
            <div className="flex items-center gap-1 text-xs text-destructive mb-1">
              <AlertTriangle className="h-3 w-3 shrink-0" />{skill.error}
            </div>
          )}
          {skill.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {skill.tags.slice(0, 5).map(t => (
                <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">{t}</Badge>
              ))}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground mt-1 font-mono">{skill.path}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0 pt-0.5">
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleSave} disabled={saving || !skill.valid}>
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
            {saving ? '' : 'Save'}
          </Button>
          <button onClick={onDiscard} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {expanded && skill.content && (
        <div className="border-t px-3 pb-3 pt-2">
          <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground leading-relaxed bg-muted/30 rounded-md p-3 max-h-80 overflow-y-auto">
            {skill.content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── GitHub import panel ────────────────────────────────────────────────────────

function GitHubImportPanel({ onSkillSaved }: { onSkillSaved: (skill: Skill) => void }) {
  const [githubUrl, setGithubUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<GitHubImportResult | null>(null);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const handleFetch = async () => {
    if (!githubUrl.trim()) { toast.error('Enter a GitHub URL first'); return; }
    setPending(true);
    setResult(null);
    setDismissed(new Set());
    try {
      const data = await importGithubSkills(githubUrl.trim());
      setResult(data);
      if (data.skills.length === 0) toast.error('No SKILL.md files found');
      else if (data.type === 'repo') toast.success(`Found ${data.skills.length} skill${data.skills.length === 1 ? '' : 's'} in ${data.repo}`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to import from GitHub');
    } finally {
      setPending(false);
    }
  };

  const handleSaveSkill = async (ghSkill: GitHubImportedSkill) => {
    const saved = await createSkill({
      name: ghSkill.name,
      description: ghSkill.description,
      tags: ghSkill.tags,
      content: ghSkill.content,
    });
    onSkillSaved(saved);
    toast.success(`Skill "${saved.id}" saved`);
  };

  const visibleSkills = result?.skills.filter((_, i) => !dismissed.has(i)) ?? [];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Paste a GitHub repo URL to import all <code className="bg-muted px-1 rounded">SKILL.md</code> files,
        or a specific file URL to import one skill.
      </p>
      <div className="space-y-2">
        <Label className="text-xs">GitHub URL</Label>
        <div className="flex gap-2">
          <Input
            value={githubUrl}
            onChange={e => setGithubUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleFetch(); }}
            placeholder="https://github.com/owner/skills  or  …/blob/main/SKILL.md"
            className="font-mono text-sm"
          />
          <Button onClick={handleFetch} disabled={pending || !githubUrl.trim()}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {result && visibleSkills.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {result.type === 'repo'
              ? <><Github className="h-3.5 w-3.5" />{result.repo} — {visibleSkills.length} skill{visibleSkills.length === 1 ? '' : 's'} found</>
              : <><FileCode className="h-3.5 w-3.5" />1 skill fetched</>}
          </div>
          {visibleSkills.map((skill, i) => (
            <GitHubSkillCard
              key={i}
              skill={skill}
              onSave={handleSaveSkill}
              onDiscard={() => setDismissed(prev => new Set(prev).add(result.skills.indexOf(skill)))}
            />
          ))}
        </div>
      )}
      {result && visibleSkills.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2">All skills handled.</p>
      )}
    </div>
  );
}

// ── Inline skill edit form with auto-save ─────────────────────────────────────

interface SkillEditFormProps {
  skill: Skill;
  onUpdated: (updated: Skill) => void;
  onCancel: () => void;
}

function SkillEditForm({ skill, onUpdated, onCancel }: SkillEditFormProps) {
  const [desc, setDesc] = useState(skill.description);
  const [tags, setTags] = useState(skill.tags.join(', '));
  const [content, setContent] = useState(skill.content);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  // Hold latest values in refs so the debounced save always reads fresh data
  const descRef = useRef(desc);
  const tagsRef = useRef(tags);
  const contentRef = useRef(content);
  useEffect(() => { descRef.current = desc; });
  useEffect(() => { tagsRef.current = tags; });
  useEffect(() => { contentRef.current = content; });

  const triggerSave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setSaveState('saving');
    timerRef.current = setTimeout(async () => {
      try {
        const updated = await updateSkill(skill.id, {
          description: descRef.current,
          tags: tagsRef.current.split(',').map(t => t.trim()).filter(Boolean),
          content: contentRef.current,
        });
        onUpdated(updated);
        setSaveState('saved');
        feedbackTimerRef.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        setSaveState('error');
        feedbackTimerRef.current = setTimeout(() => setSaveState('idle'), 3000);
      }
    }, 600);
  };

  const handleChange = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setter(e.target.value);
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    triggerSave();
  };

  // Cleanup on unmount
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

  return (
    <CardContent className="pt-4 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground font-mono">{skill.id}</span>
        {saveState === 'saving' && (
          <span className="text-xs text-muted-foreground animate-pulse">Saving…</span>
        )}
        {saveState === 'saved' && (
          <span className="text-xs text-green-500">&#x2713; Saved</span>
        )}
        {saveState === 'error' && (
          <span className="text-xs text-destructive">Failed to save</span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Description</Label>
          <Input value={desc} onChange={handleChange(setDesc)} />
        </div>
        <div className="space-y-1">
          <Label>Tags</Label>
          <Input value={tags} onChange={handleChange(setTags)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Content</Label>
        <textarea
          value={content}
          onChange={handleChange(setContent)}
          className="w-full h-48 rounded-md border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-3 w-3 mr-1" /> Done
        </Button>
      </div>
    </CardContent>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type NewSkillTab = 'manual' | 'paste' | 'github';

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [accessPanelId, setAccessPanelId] = useState<string | null>(null);
  const [newSkillTab, setNewSkillTab] = useState<NewSkillTab>('manual');

  // Create form
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newContent, setNewContent] = useState('');
  const [creating, setCreating] = useState(false);

  // Paste tab
  const [pasteContent, setPasteContent] = useState('');
  const [parsePending, setParsePending] = useState(false);

  // Edit form state is now managed inside SkillEditForm component

  useEffect(() => {
    Promise.all([fetchSkills(), fetchAgents()])
      .then(([s, a]) => { setSkills(s); setAgents(a); })
      .catch(() => toast.error('Failed to load data'))
      .finally(() => setLoading(false));
  }, []);

  const resetCreateForm = () => {
    setNewName(''); setNewDesc(''); setNewTags(''); setNewContent('');
    setPasteContent('');
    setNewSkillTab('manual');
  };

  const handleCreate = async () => {
    if (!newName.trim() || !newContent.trim()) { toast.error('Name and content are required'); return; }
    setCreating(true);
    try {
      const skill = await createSkill({
        name: newName.trim(),
        description: newDesc.trim() || `Skill: ${newName.trim()}`,
        tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
        content: newContent.trim(),
      });
      setSkills(prev => [...prev, skill]);
      setShowCreate(false);
      resetCreateForm();
      toast.success(`Skill "${skill.id}" created`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create skill');
    } finally {
      setCreating(false);
    }
  };

  const handleParsePaste = async () => {
    if (!pasteContent.trim()) { toast.error('Paste some skill content first'); return; }
    setParsePending(true);
    try {
      const result = await parseSkill({ raw: pasteContent });
      if (!result.valid) { toast.error(result.error || 'Invalid skill content'); return; }
      setNewName(result.name);
      setNewDesc(result.description);
      setNewTags(result.tags.join(', '));
      setNewContent(pasteContent.replace(/^---[\s\S]*?---\n*/, '').trim());
      setNewSkillTab('manual');
      toast.success('Skill parsed — review and save below');
    } catch (err: any) {
      toast.error(err.message || 'Failed to parse skill');
    } finally {
      setParsePending(false);
    }
  };

  const handleToggleEnabled = async (skill: Skill) => {
    try {
      const updated = await setSkillEnabled(skill.id, !skill.enabled);
      setSkills(prev => prev.map(s => s.id === updated.id ? updated : s));
      toast.success(`Skill "${skill.id}" ${updated.enabled ? 'enabled' : 'disabled'}`);
    } catch {
      toast.error('Failed to toggle skill');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete skill "${id}"? This cannot be undone.`)) return;
    try {
      await deleteSkill(id);
      setSkills(prev => prev.filter(s => s.id !== id));
      toast.success(`Skill "${id}" deleted`);
    } catch {
      toast.error('Failed to delete skill');
    }
  };

  const startEdit = (skill: Skill) => {
    setEditingId(skill.id);
    setAccessPanelId(null);
  };

  const handleSkillUpdated = (updated: Skill) => {
    setSkills(prev => prev.map(s => s.id === updated.id ? updated : s));
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Zap className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Skill Library</h1>
            <p className="text-muted-foreground text-sm">Create and manage skills.</p>
          </div>
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <Skeleton circle width={16} height={16} />
                    <Skeleton width={120} height={16} />
                    <Skeleton width={200} height={14} />
                  </div>
                  <div className="flex gap-1.5">
                    <Skeleton width={50} height={20} />
                    <Skeleton width={40} height={20} />
                    <Skeleton width={60} height={20} />
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Skeleton width={28} height={28} />
                  <Skeleton width={28} height={28} />
                  <Skeleton width={28} height={28} />
                  <Skeleton width={28} height={28} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Zap className="h-8 w-8 shrink-0" />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Skill Library</h1>
            <p className="text-muted-foreground text-sm">
              Create and manage skills. Grant agents access via the <Users className="inline h-3.5 w-3.5 mx-0.5" /> button on each skill.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a href="/skills/generate">
            <Button variant="outline" size="sm">
              <Sparkles className="h-4 w-4 mr-2" />Generate
            </Button>
          </a>
          <Button
            size="sm"
            onClick={() => { setShowCreate(v => !v); if (showCreate) resetCreateForm(); }}
            variant={showCreate ? 'outline' : 'default'}
          >
            {showCreate ? <X className="h-4 w-4 mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            {showCreate ? 'Cancel' : 'New Skill'}
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card className="border-primary/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New Skill</CardTitle>
            <CardDescription>
              Skills are added to the library. Use the <Users className="inline h-3 w-3 mx-0.5" /> access panel to grant agents access after creation.
            </CardDescription>
            <div className="flex items-center gap-1 rounded-lg border p-1 bg-muted/40 mt-2 w-fit">
              {([
                { id: 'manual', icon: Plus, label: 'Manual' },
                { id: 'paste', icon: Clipboard, label: 'Paste Raw' },
                { id: 'github', icon: Github, label: 'GitHub' },
              ] as const).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => setNewSkillTab(id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    newSkillTab === id ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />{label}
                </button>
              ))}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {newSkillTab === 'manual' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>Name <span className="text-destructive">*</span></Label>
                    <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="github-pr" className="font-mono" />
                    <p className="text-xs text-muted-foreground">Lowercase slug, e.g. github-pr</p>
                  </div>
                  <div className="space-y-1">
                    <Label>Description</Label>
                    <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Opening and merging GitHub pull requests" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Tags (comma-separated)</Label>
                  <Input value={newTags} onChange={e => setNewTags(e.target.value)} placeholder="github, git, pr" />
                </div>
                <div className="space-y-1">
                  <Label>Content <span className="text-destructive">*</span></Label>
                  <textarea
                    value={newContent}
                    onChange={e => setNewContent(e.target.value)}
                    placeholder="# GitHub PR Skill&#10;&#10;When creating a pull request..."
                    className="w-full h-48 rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
                <Button onClick={handleCreate} disabled={creating}>
                  {creating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                  Create Skill
                </Button>
              </>
            )}

            {newSkillTab === 'paste' && (
              <>
                <p className="text-xs text-muted-foreground">
                  Paste a raw SKILL.md file including YAML frontmatter. Fields will be parsed for review.
                </p>
                <textarea
                  value={pasteContent}
                  onChange={e => setPasteContent(e.target.value)}
                  placeholder={`---\nname: my-skill\ndescription: Use when doing X\ntags: [x, y, z]\nenabled: true\n---\n\n# My Skill\n\nInstructions here...`}
                  className="w-full h-64 rounded-md border bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                />
                <Button onClick={handleParsePaste} disabled={parsePending || !pasteContent.trim()}>
                  {parsePending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Clipboard className="h-4 w-4 mr-2" />}
                  Parse &amp; Review
                </Button>
              </>
            )}

            {newSkillTab === 'github' && (
              <GitHubImportPanel
                onSkillSaved={skill => setSkills(prev => {
                  const exists = prev.some(s => s.id === skill.id);
                  return exists ? prev.map(s => s.id === skill.id ? skill : s) : [...prev, skill];
                })}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Skills list */}
      {skills.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Zap className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No skills in the library yet.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create your first skill or let agents create skills via <code className="text-xs bg-muted px-1 py-0.5 rounded">create_skill()</code>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {skills.map(skill => (
            <div key={skill.id}>
              <Card className={skill.enabled ? '' : 'opacity-60'}>
                {editingId === skill.id ? (
                  <SkillEditForm
                    skill={skill}
                    onUpdated={handleSkillUpdated}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {skill.scope === 'agent'
                            ? <User className="h-4 w-4 text-muted-foreground shrink-0" />
                            : <Globe className="h-4 w-4 text-muted-foreground shrink-0" />}
                          <code className="font-mono font-semibold text-sm">{skill.id}</code>
                          <span className="text-sm text-muted-foreground">{skill.description}</span>
                          {skill.scope === 'agent' && skill.owner_agent_id && (
                            <Badge variant="outline" className="text-xs">owned by {skill.owner_agent_id}</Badge>
                          )}
                          {!skill.enabled && (
                            <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/30">Disabled</Badge>
                          )}
                        </div>
                        {skill.tags.length > 0 && (
                          <div className="flex gap-1 mt-2 flex-wrap">
                            {skill.tags.map(tag => (
                              <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Access management */}
                        <button
                          onClick={() => setAccessPanelId(accessPanelId === skill.id ? null : skill.id)}
                          title="Manage agent access"
                          className={`p-1.5 rounded hover:bg-muted transition-colors ${accessPanelId === skill.id ? 'bg-primary/10 text-primary' : ''}`}
                        >
                          <Users className="h-4 w-4" />
                        </button>
                        {/* Enable/disable */}
                        <button
                          onClick={() => handleToggleEnabled(skill)}
                          title={skill.enabled ? 'Disable skill globally' : 'Enable skill globally'}
                          className="p-1.5 rounded hover:bg-muted transition-colors"
                        >
                          {skill.enabled
                            ? <ToggleRight className="h-5 w-5 text-primary" />
                            : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
                        </button>
                        <button onClick={() => startEdit(skill)} title="Edit skill" className="p-1.5 rounded hover:bg-muted transition-colors">
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(skill.id)}
                          title="Delete skill"
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>
              {/* Access panel expands below the card */}
              {accessPanelId === skill.id && (
                <AccessPanel
                  skill={skill}
                  agents={agents}
                  onClose={() => setAccessPanelId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ShieldCheck,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Lock,
  ChevronDown,
  ChevronUp,
  Loader2,
  Key,
  UserCheck,
  UserX,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
  grantSecret,
  revokeSecret,
  fetchAgents,
  type SecretItem,
  type AgentListItem,
} from '@/lib/api';

// ── Secret type helpers ────────────────────────────────────────────────────────

const SECRET_TYPES = [
  { value: 'pat',      label: 'Personal Access Token' },
  { value: 'ssh_key',  label: 'SSH Private Key' },
  { value: 'env_var',  label: 'Environment Variable' },
  { value: 'password', label: 'Password' },
  { value: 'api_key',  label: 'API Key' },
  { value: 'token',    label: 'Token' },
  { value: 'other',    label: 'Other' },
];

const SECRET_TYPE_HINTS: Record<string, string> = {
  pat:      'e.g. ghp_xxxx, glpat-xxxx — used by git operations in the agent container',
  ssh_key:  'PEM-encoded private key — e.g. contents of ~/.ssh/id_ed25519',
  env_var:  'A general environment variable injected into the agent container',
  password: 'A password used by tools or scripts inside the agent',
  api_key:  'API key for a service the agent needs to call',
  token:    'Bearer token or access token',
  other:    'Any other sensitive credential',
};

// ── Create secret form ─────────────────────────────────────────────────────────

interface CreateFormProps {
  agents: AgentListItem[];
  onCreated: (secret: SecretItem) => void;
  onCancel: () => void;
}

function CreateSecretForm({ agents, onCreated, onCancel }: CreateFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [secretType, setSecretType] = useState('pat');
  const [envKey, setEnvKey] = useState('');
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [grantedAgents, setGrantedAgents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Auto-suggest env_key from name
  const handleNameChange = (v: string) => {
    setName(v);
    if (!envKey) {
      setEnvKey(v.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
    }
  };

  const toggleAgent = (agentId: string) => {
    setGrantedAgents(prev =>
      prev.includes(agentId) ? prev.filter(a => a !== agentId) : [...prev, agentId]
    );
  };

  const handleSave = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    if (!envKey.trim()) { toast.error('Environment variable name is required'); return; }
    if (!value.trim()) { toast.error('Secret value is required'); return; }

    setSaving(true);
    try {
      const created = await createSecret({
        name: name.trim(),
        description: description.trim() || undefined,
        secret_type: secretType,
        env_key: envKey.trim(),
        value: value.trim(),
      });

      // Grant to selected agents
      await Promise.all(
        grantedAgents.map(agentId => grantSecret(created.id, agentId).catch(() => {}))
      );

      // Reload to pick up grants
      const updated = { ...created, granted_agents: grantedAgents };
      toast.success(`Secret "${created.name}" created`);
      onCreated(updated);
    } catch (err) {
      toast.error(`Failed to create secret: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">New Secret</CardTitle>
        </div>
        <CardDescription className="text-xs">
          The secret value is encrypted with AES-256-GCM before being stored.
          It will never be shown again after creation — only a masked preview is kept.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Name + type row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="sec-name">Name <span className="text-destructive">*</span></Label>
            <Input
              id="sec-name"
              placeholder="GitHub PAT — finn's fork"
              value={name}
              onChange={e => handleNameChange(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sec-type">Type</Label>
            <Select value={secretType} onValueChange={setSecretType}>
              <SelectTrigger id="sec-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECRET_TYPES.map(t => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Env key */}
        <div className="space-y-1.5">
          <Label htmlFor="sec-env-key">
            Environment Variable Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="sec-env-key"
            placeholder="GITHUB_TOKEN"
            value={envKey}
            onChange={e => setEnvKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {SECRET_TYPE_HINTS[secretType]}
          </p>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="sec-desc">Description <span className="text-muted-foreground">(optional)</span></Label>
          <Input
            id="sec-desc"
            placeholder="PAT for finn's access to private repos on GitHub"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>

        {/* Secret value */}
        <div className="space-y-1.5">
          <Label htmlFor="sec-value">
            Secret Value <span className="text-destructive">*</span>
          </Label>
          <div className="relative">
            {secretType === 'ssh_key' ? (
              <Textarea
                id="sec-value"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                value={value}
                onChange={e => setValue(e.target.value)}
                className="font-mono text-xs min-h-[120px] pr-10"
                style={{ WebkitTextSecurity: showValue ? 'none' : 'disc' } as React.CSSProperties}
              />
            ) : (
              <Input
                id="sec-value"
                type={showValue ? 'text' : 'password'}
                placeholder="Enter secret value..."
                value={value}
                onChange={e => setValue(e.target.value)}
                className="font-mono pr-10"
                autoComplete="new-password"
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowValue(v => !v)}
              tabIndex={-1}
            >
              {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5 text-green-500 shrink-0" />
            Encrypted immediately — the plaintext is never persisted or logged.
          </p>
        </div>

        {/* Agent grants */}
        {agents.length > 0 && (
          <div className="space-y-2">
            <Label>Grant to Agents <span className="text-muted-foreground">(optional)</span></Label>
            <p className="text-xs text-muted-foreground">
              Only selected agents will receive this secret as an environment variable.
            </p>
            <div className="flex flex-wrap gap-2">
              {agents.map(agent => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggleAgent(agent.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    grantedAgents.includes(agent.id)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  {agent.emoji && <span>{agent.emoji}</span>}
                  {agent.name}
                  {grantedAgents.includes(agent.id) && (
                    <UserCheck className="h-3 w-3" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim() || !envKey.trim() || !value.trim()}>
            {saving ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving...</>
            ) : (
              <><Lock className="h-4 w-4 mr-2" /> Create Secret</>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Secret card (view + edit) ──────────────────────────────────────────────────

interface SecretCardProps {
  secret: SecretItem;
  agents: AgentListItem[];
  onUpdate: (updated: SecretItem) => void;
  onDelete: (id: string) => void;
}

function SecretCard({ secret, agents, onUpdate, onDelete }: SecretCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingValue, setEditingValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [togglingAgent, setTogglingAgent] = useState<string | null>(null);

  const handleRotate = async () => {
    if (!editingValue.trim()) { toast.error('Enter a new value to rotate'); return; }
    setSaving(true);
    try {
      const updated = await updateSecret(secret.id, { value: editingValue.trim() });
      setEditingValue('');
      toast.success('Secret rotated');
      onUpdate({ ...updated, granted_agents: secret.granted_agents });
    } catch (err) {
      toast.error(`Failed to rotate: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteSecret(secret.id);
      toast.success(`Secret "${secret.name}" deleted`);
      onDelete(secret.id);
    } catch (err) {
      toast.error(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleToggleAgent = async (agentId: string) => {
    const isGranted = secret.granted_agents.includes(agentId);
    setTogglingAgent(agentId);
    try {
      if (isGranted) {
        await revokeSecret(secret.id, agentId);
        onUpdate({ ...secret, granted_agents: secret.granted_agents.filter(a => a !== agentId) });
        toast.success(`Revoked from ${agentId}`);
      } else {
        await grantSecret(secret.id, agentId);
        onUpdate({ ...secret, granted_agents: [...secret.granted_agents, agentId] });
        toast.success(`Granted to ${agentId}`);
      }
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setTogglingAgent(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Key className="h-4 w-4 text-muted-foreground shrink-0" />
                <CardTitle className="text-sm font-semibold">{secret.name}</CardTitle>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                  {secret.env_key}
                </Badge>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {secret.secret_type_label}
                </Badge>
              </div>
              {secret.description && (
                <CardDescription className="text-xs">{secret.description}</CardDescription>
              )}
              <div className="flex items-center gap-1.5 mt-1">
                <Lock className="h-3 w-3 text-green-500" />
                <span className="text-xs text-muted-foreground font-mono">
                  {secret.masked_preview ?? '***'}
                </span>
                <span className="text-xs text-muted-foreground">•</span>
                <ShieldCheck className="h-3 w-3 text-green-500" />
                <span className="text-xs text-green-600">Encrypted at rest</span>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                title="Delete secret"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setExpanded(e => !e)}
                title={expanded ? 'Collapse' : 'Manage agents & rotate'}
              >
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </CardHeader>

        {expanded && (
          <CardContent className="space-y-4 pt-0">
            {/* Agent grants */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Agent Access
              </p>
              {agents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No agents configured.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {agents.map(agent => {
                    const isGranted = secret.granted_agents.includes(agent.id);
                    const isToggling = togglingAgent === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => handleToggleAgent(agent.id)}
                        disabled={isToggling}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                          isGranted
                            ? 'border-green-500/50 bg-green-500/10 text-green-700 dark:text-green-400'
                            : 'border-border text-muted-foreground hover:border-primary/50'
                        }`}
                      >
                        {isToggling ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : isGranted ? (
                          <UserCheck className="h-3 w-3" />
                        ) : (
                          <UserX className="h-3 w-3" />
                        )}
                        {agent.emoji && <span>{agent.emoji}</span>}
                        {agent.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Tap an agent to toggle access. Granted agents receive this secret as{' '}
                <code className="font-mono text-[11px] bg-muted px-1 rounded">{secret.env_key}</code>{' '}
                when their container starts.
              </p>
            </div>

            {/* Rotate value */}
            <div className="space-y-2 border-t pt-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Rotate Secret Value
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showValue ? 'text' : 'password'}
                    placeholder="Enter new value to rotate..."
                    value={editingValue}
                    onChange={e => setEditingValue(e.target.value)}
                    className="font-mono pr-9 text-sm"
                    autoComplete="new-password"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 h-7 w-7"
                    onClick={() => setShowValue(v => !v)}
                    tabIndex={-1}
                  >
                    {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRotate}
                  disabled={saving || !editingValue.trim()}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Rotate</>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-green-500 shrink-0" />
                New value is encrypted immediately. Previous value is overwritten and unrecoverable.
              </p>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Secret
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>"{secret.name}"</strong>?
              This will also revoke access for all {secret.granted_agents.length} agent(s).
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Main SecretsSettings component ────────────────────────────────────────────

export function SecretsSettings() {
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [secsData, agentsData] = await Promise.all([fetchSecrets(), fetchAgents()]);
      setSecrets(secsData);
      setAgents(agentsData);
    } catch (err) {
      toast.error('Failed to load secrets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = (secret: SecretItem) => {
    setSecrets(prev => [secret, ...prev]);
    setShowCreateForm(false);
  };

  const handleUpdated = (updated: SecretItem) => {
    setSecrets(prev => prev.map(s => s.id === updated.id ? updated : s));
  };

  const handleDeleted = (id: string) => {
    setSecrets(prev => prev.filter(s => s.id !== id));
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Store credentials your agents need — GitHub PATs, GitLab tokens, SSH keys, and more.
            Secrets are encrypted with AES-256-GCM and injected only into the agents you choose.
          </p>
        </div>
        <Button
          onClick={() => setShowCreateForm(v => !v)}
          size="sm"
          variant={showCreateForm ? 'outline' : 'default'}
          className="shrink-0"
        >
          <Plus className="h-4 w-4 mr-1.5" />
          New Secret
        </Button>
      </div>

      {/* Security callout */}
      <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 flex items-start gap-2.5">
        <ShieldCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
        <div className="space-y-0.5">
          <p className="text-xs font-medium text-green-700 dark:text-green-400">
            Encrypted at rest, pulled on demand
          </p>
          <p className="text-xs text-muted-foreground">
            Secret values are encrypted with AES-256-GCM before being written to the database.
            The plaintext is never logged and never returned by the API. When an agent needs a
            credential, it calls the <code className="font-mono text-[11px] bg-muted px-1 rounded">get_secret</code> tool
            at the moment it's required — nothing is pre-loaded into the environment.
          </p>
        </div>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <CreateSecretForm
          agents={agents}
          onCreated={handleCreated}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Skeleton circle width={16} height={16} />
                    <Skeleton width={130} height={15} />
                    <Skeleton width={80} height={18} />
                    <Skeleton width={60} height={18} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Skeleton circle width={12} height={12} />
                    <Skeleton width={100} height={12} />
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Skeleton width={32} height={32} />
                  <Skeleton width={32} height={32} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : secrets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Lock className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No secrets yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create a secret to give agents access to private repositories, APIs, or other services.
          </p>
          <Button className="mt-4" size="sm" onClick={() => setShowCreateForm(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Create your first secret
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {secrets.map(secret => (
            <SecretCard
              key={secret.id}
              secret={secret}
              agents={agents}
              onUpdate={handleUpdated}
              onDelete={handleDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}

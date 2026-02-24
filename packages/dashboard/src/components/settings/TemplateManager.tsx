import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Plus, Trash2, Copy, Columns3, Sparkles, Save, ChevronDown, ChevronRight, GripVertical,
} from 'lucide-react';
import { toast } from 'sonner';
import { StatusSemanticsDisplay } from '@/components/projects/StatusSemanticsDisplay';
import {
  fetchProjectTemplates,
  createProjectTemplate,
  updateProjectTemplate,
  deleteProjectTemplate,
  cloneProjectTemplate,
  type ProjectTemplate,
  type ProjectTemplateColumn,
  type StatusSemantics,
} from '@/lib/api';

export function TemplateManager() {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    try {
      const data = await fetchProjectTemplates();
      setTemplates(data);
    } catch {
      toast.error('Failed to load templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleClone = async (id: string) => {
    try {
      await cloneProjectTemplate(id);
      await load();
      toast.success('Template cloned');
    } catch { toast.error('Failed to clone'); }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProjectTemplate(id);
      setTemplates(prev => prev.filter(t => t.id !== id));
      toast.success('Template deleted');
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground p-4">Loading templates...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Project Templates</h3>
          <p className="text-sm text-muted-foreground">
            Manage reusable project templates with custom columns and workflows
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          <Plus className="h-4 w-4 mr-1" /> New Template
        </Button>
      </div>

      {showCreate && (
        <CreateTemplateForm
          onCreated={() => { setShowCreate(false); load(); }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="space-y-2">
        {templates.map((tmpl) => {
          const isExpanded = expanded === tmpl.id;
          return (
            <Card key={tmpl.id}>
              <div
                className="flex items-center gap-3 p-4 cursor-pointer"
                onClick={() => setExpanded(isExpanded ? null : tmpl.id)}
              >
                <span className="text-lg">{tmpl.icon || '📁'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{tmpl.name}</span>
                    {tmpl.isBuiltin && <Badge variant="secondary" className="text-[10px]">Built-in</Badge>}
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <Columns3 className="h-2.5 w-2.5" />
                      {tmpl.columns.length}
                    </Badge>
                    {tmpl.onboardingAgentChain && (
                      <Badge variant="outline" className="text-[10px] gap-1">
                        <Sparkles className="h-2.5 w-2.5" />
                        Onboarding
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{tmpl.description}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); handleClone(tmpl.id); }}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  {!tmpl.isBuiltin && (
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={(e) => { e.stopPropagation(); handleDelete(tmpl.id); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </div>
              </div>

              {isExpanded && (
                <TemplateDetail
                  template={tmpl}
                  onUpdated={load}
                />
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// Template Detail (expanded view)
// ═══════════════════════════════════════════════════════════════════════════

function TemplateDetail({ template, onUpdated }: { template: ProjectTemplate; onUpdated: () => void }) {
  return (
    <div className="border-t px-4 pb-4 pt-3 space-y-4">
      {/* Columns */}
      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Columns</Label>
        <div className="space-y-1 mt-1">
          {template.columns.map((col, i) => (
            <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/30 text-xs">
              <span className="text-muted-foreground w-5 text-right">{col.position}</span>
              <span className="font-medium flex-1">{col.name}</span>
              {col.wip_limit && (
                <Badge variant="outline" className="text-[9px]">WIP: {col.wip_limit}</Badge>
              )}
              <span className="text-muted-foreground font-mono">{col.statuses.join(', ')}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Status Semantics */}
      <StatusSemanticsDisplay semantics={template.statusSemantics as any} />

      {/* Onboarding */}
      {template.onboardingAgentChain && (
        <div>
          <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Onboarding Agent Chain</Label>
          <div className="flex items-center gap-1 mt-1">
            {template.onboardingAgentChain.map((agentId, i) => (
              <span key={agentId}>
                <Badge variant="outline" className="text-xs">{agentId}</Badge>
                {i < template.onboardingAgentChain!.length - 1 && (
                  <span className="text-muted-foreground mx-1">{"→"}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div>
        <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Metadata</Label>
        <pre className="mt-1 text-[10px] bg-muted/30 rounded p-2 overflow-x-auto">
          {JSON.stringify(template.metadata, null, 2)}
        </pre>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// Create Template Form
// ═══════════════════════════════════════════════════════════════════════════

function CreateTemplateForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [columns, setColumns] = useState<ProjectTemplateColumn[]>([
    { name: 'To Do', position: 0, wip_limit: null, statuses: ['todo'] },
    { name: 'In Progress', position: 1, wip_limit: 5, statuses: ['in_progress'] },
    { name: 'Done', position: 2, wip_limit: null, statuses: ['done'] },
  ]);
  const [saving, setSaving] = useState(false);

  const handleNameChange = (v: string) => {
    setName(v);
    if (!slug || slug === autoSlug(name)) {
      setSlug(autoSlug(v));
    }
  };

  const autoSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const addColumn = () => {
    setColumns([...columns, { name: '', position: columns.length, wip_limit: null, statuses: [] }]);
  };

  const removeColumn = (idx: number) => {
    setColumns(columns.filter((_, i) => i !== idx).map((c, i) => ({ ...c, position: i })));
  };

  const updateColumn = (idx: number, field: string, value: any) => {
    setColumns(columns.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  };

  const handleSave = async () => {
    if (!name.trim() || !slug.trim() || columns.length === 0) {
      toast.error('Name, slug, and at least one column required');
      return;
    }
    // Auto-derive statuses from column names if empty
    const finalColumns = columns.map(c => ({
      ...c,
      statuses: c.statuses.length > 0 ? c.statuses : [c.name.toLowerCase().replace(/\s+/g, '_')],
    }));

    const allStatuses = finalColumns.flatMap(c => c.statuses);
    const semantics: StatusSemantics = {
      initial: allStatuses.length > 0 ? [allStatuses[0]] : [],
      terminal_done: allStatuses.length > 0 ? [allStatuses[allStatuses.length - 1]] : [],
      terminal_fail: [],
      blocked: [],
      in_progress: [],
      claimable: allStatuses.length > 0 ? [allStatuses[0]] : [],
    };

    setSaving(true);
    try {
      await createProjectTemplate({
        name: name.trim(),
        slug: slug.trim(),
        description,
        icon: icon || undefined,
        columns: finalColumns,
        statusSemantics: semantics,
      });
      toast.success('Template created');
      onCreated();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">Name</Label>
            <Input value={name} onChange={(e) => handleNameChange(e.target.value)} className="h-9 mt-1" placeholder="My Workflow" />
          </div>
          <div>
            <Label className="text-xs">Icon (emoji)</Label>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} className="h-9 mt-1" placeholder="📋" maxLength={4} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Slug</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} className="h-9 mt-1 font-mono" placeholder="my-workflow" />
          </div>
          <div>
            <Label className="text-xs">Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="h-9 mt-1" placeholder="Short description" />
          </div>
        </div>

        {/* Column editor */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs">Columns</Label>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addColumn}>
              <Plus className="h-3 w-3 mr-1" /> Add Column
            </Button>
          </div>
          <div className="space-y-2">
            {columns.map((col, idx) => (
              <div key={idx} className="flex items-center gap-2 p-2 rounded border bg-muted/20">
                <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                <Input
                  value={col.name}
                  onChange={(e) => updateColumn(idx, 'name', e.target.value)}
                  className="h-7 text-xs flex-1"
                  placeholder="Column name"
                />
                <Input
                  value={col.statuses.join(', ')}
                  onChange={(e) => updateColumn(idx, 'statuses', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                  className="h-7 text-xs w-32 font-mono"
                  placeholder="status1, status2"
                />
                <Input
                  type="number"
                  value={col.wip_limit ?? ''}
                  onChange={(e) => updateColumn(idx, 'wip_limit', e.target.value ? parseInt(e.target.value) : null)}
                  className="h-7 text-xs w-16"
                  placeholder="WIP"
                />
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeColumn(idx)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" /> {saving ? 'Creating...' : 'Create Template'}
          </Button>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createMemoryFile } from '@/lib/api';

const CATEGORIES = [
  { value: 'decisions', label: 'Decision', icon: '⚖️' },
  { value: 'lessons', label: 'Lesson', icon: '💡' },
  { value: 'observations', label: 'Observation', icon: '👁️' },
  { value: 'patterns', label: 'Pattern', icon: '🔄' },
  { value: 'preferences', label: 'Preference', icon: '⭐' },
  { value: 'people', label: 'Person', icon: '👤' },
  { value: 'handoffs', label: 'Handoff', icon: '🤝' },
  { value: 'inbox', label: 'Quick Note', icon: '📥' },
];

interface CreateMemoryDialogProps {
  agentId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (filename: string) => void;
}

export function CreateMemoryDialog({ agentId, open, onClose, onCreated }: CreateMemoryDialogProps) {
  const [category, setCategory] = useState('inbox');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [shared, setShared] = useState(false);
  const [creating, setCreating] = useState(false);

  if (!open) return null;

  const handleCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);

    // Build frontmatter + content
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const filename = `${category}/${slug}.md`;
    const fullContent = [
      '---',
      `category: ${category}`,
      `title: ${title}`,
      `createdAt: ${Date.now()}`,
      shared ? `shared: true` : null,
      '---',
      '',
      content,
    ].filter(Boolean).join('\n');

    try {
      const result = await createMemoryFile(agentId, fullContent, filename);
      onCreated?.(result.filename);
      // Reset form
      setTitle('');
      setContent('');
      setCategory('inbox');
      setShared(false);
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-xl w-[560px] max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Create Memory</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Category */}
          <div>
            <label className="text-sm font-medium mb-1 block">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full h-10 rounded-md border bg-background px-3 text-sm"
            >
              {CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.icon} {c.label}</option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label className="text-sm font-medium mb-1 block">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Brief, descriptive title..."
              autoFocus
            />
          </div>

          {/* Content */}
          <div>
            <label className="text-sm font-medium mb-1 block">Content</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Memory content (Markdown supported)..."
              rows={8}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y"
            />
          </div>

          {/* Shared toggle */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
              className="rounded"
            />
            Also save to shared vault
          </label>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} disabled={!title.trim() || creating}>
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}

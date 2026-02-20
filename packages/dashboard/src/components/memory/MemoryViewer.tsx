import { useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { fetchMemoryFile } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { MemoryEditor } from './MemoryEditor';

interface MemoryFileContent {
  content: string;
  metadata: Record<string, any>;
}

interface MemoryViewerProps {
  agentId: string;
  filename: string | null;
}

function EmptyState({ icon: Icon, message }: { icon: typeof Brain; message: string }) {
  return (
    <Card className="h-full border-dashed">
      <CardContent className="flex flex-col items-center justify-center h-full text-muted-foreground py-12">
        <Icon className="h-8 w-8 mb-3" />
        <p className="text-sm">{message}</p>
      </CardContent>
    </Card>
  );
}

// Simple markdown-like rendering
function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n');
  
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {lines.map((line, i) => {
        // Headers
        if (line.startsWith('# ')) {
          return <h1 key={i} className="text-2xl font-bold mt-4 mb-2">{line.slice(2)}</h1>;
        }
        if (line.startsWith('## ')) {
          return <h2 key={i} className="text-xl font-semibold mt-4 mb-2">{line.slice(3)}</h2>;
        }
        if (line.startsWith('### ')) {
          return <h3 key={i} className="text-lg font-semibold mt-3 mb-1">{line.slice(4)}</h3>;
        }
        // List items
        if (line.startsWith('- ') || line.startsWith('* ')) {
          return <li key={i} className="ml-4">{line.slice(2)}</li>;
        }
        // Horizontal rule
        if (line.startsWith('---') || line.startsWith('***') || line.startsWith('___')) {
          return <hr key={i} className="my-4" />;
        }
        // Code block markers
        if (line.startsWith('```')) {
          return null;
        }
        // Empty line
        if (!line.trim()) {
          return <br key={i} />;
        }
        // Regular paragraph
        return <p key={i} className="my-1">{line}</p>;
      })}
    </div>
  );
}

export function MemoryViewer({ agentId, filename }: MemoryViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  
  // Check if file is a template (templates are read-only)
  const isTemplate = filename?.includes('template') || filename?.includes('.template.');
  const canEdit = !isTemplate;
  
  useEffect(() => {
    if (!filename) {
      setContent(null);
      setMetadata({});
      return;
    }
    
    setLoading(true);
    fetchMemoryFile(agentId, filename)
      .then((data: MemoryFileContent) => {
        setContent(data.content);
        setMetadata(data.metadata || {});
      })
      .catch(() => {
        setContent('(Failed to load file)');
        setMetadata({});
      })
      .finally(() => setLoading(false));
  }, [agentId, filename]);
  
  if (!filename) {
    return <EmptyState icon={Brain} message="Select a memory file to view" />;
  }
  
  return (
    <div className="h-full overflow-auto">
      {/* Metadata bar */}
      <div className="flex items-center gap-2 p-3 border-b bg-muted/30 sticky top-0">
        <h3 className="font-mono text-sm truncate">{filename}</h3>
        {metadata.category && <Badge>{metadata.category}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {canEdit && (
            <div className="flex gap-1 rounded-md border p-0.5">
              <button
                onClick={() => setMode('read')}
                className={cn("px-2 py-1 text-xs rounded", mode === 'read' && "bg-primary text-primary-foreground")}
              >
                Read
              </button>
              <button
                onClick={() => setMode('edit')}
                className={cn("px-2 py-1 text-xs rounded", mode === 'edit' && "bg-primary text-primary-foreground")}
              >
                Edit
              </button>
            </div>
          )}
          <Button size="sm" variant="destructive">Delete</Button>
        </div>
      </div>
      
      {/* Content */}
      <div className="p-4 h-[calc(100%-52px)]">
        {loading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : content ? (
          mode === 'read' ? (
            <MarkdownRenderer content={content} />
          ) : (
            <MemoryEditor
              agentId={agentId}
              filename={filename!}
              initialContent={content}
              onSave={(newContent) => {
                setContent(newContent);
                setMode('read');
              }}
              onCancel={() => setMode('read')}
            />
          )
        ) : (
          <p className="text-muted-foreground">No content</p>
        )}
      </div>
    </div>
  );
}
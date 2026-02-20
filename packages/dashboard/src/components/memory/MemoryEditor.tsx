import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { keymap } from '@codemirror/view';
import { updateMemoryFile } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface MemoryEditorProps {
  agentId: string;
  filename: string;
  initialContent: string;
  onSave?: (content: string) => void;
  onCancel?: () => void;
}

/**
 * Normalize escaped whitespace sequences that sometimes appear in
 * agent-generated markdown.  Replaces literal two-character `\n`, `\t`,
 * `\r` sequences with real whitespace so the editor displays properly.
 */
function normalizeEscapes(raw: string): string {
  // Replace literal \r\n first, then standalone \n and \t.
  // Use a regex that matches a real backslash followed by the letter.
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

export function MemoryEditor({ agentId, filename, initialContent, onSave, onCancel }: MemoryEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // Normalize once so the editor and change-detection use the same baseline.
  const normalizedContent = normalizeEscapes(initialContent);

  const handleSave = async () => {
    if (!viewRef.current) return;
    const content = viewRef.current.state.doc.toString();
    setSaving(true);
    try {
      await updateMemoryFile(agentId, filename, content);
      setHasChanges(false);
      onSave?.(content);
    } catch (error) {
      console.error('Failed to save memory file:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!viewRef.current) return;
    viewRef.current.dispatch({
      changes: { from: 0, to: viewRef.current.state.doc.length, insert: normalizedContent },
    });
    setHasChanges(false);
    onCancel?.();
  };

  useEffect(() => {
    if (!editorRef.current) return;

    const isDark = document.documentElement.classList.contains('dark');

    const state = EditorState.create({
      doc: normalizedContent,
      extensions: [
        basicSetup,
        markdown(),
        ...(isDark ? [oneDark] : []),
        keymap.of([{
          key: 'Mod-s',
          run: () => { 
            if (hasChanges && !saving) {
              handleSave();
            }
            return true; 
          },
        }]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setHasChanges(update.state.doc.toString() !== normalizedContent);
          }
        }),
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
      ],
    });

    const view = new EditorView({ state, parent: editorRef.current });
    viewRef.current = view;

    return () => view.destroy();
  }, [normalizedContent]);

  return (
    <div className="h-full flex flex-col">
      <div ref={editorRef} className="flex-1 overflow-hidden border rounded-md" />
      <div className="flex items-center gap-2 mt-2 justify-end">
        {hasChanges && (
          <span className="text-xs text-yellow-500 mr-auto">Unsaved changes</span>
        )}
        <Button size="sm" variant="outline" onClick={handleDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

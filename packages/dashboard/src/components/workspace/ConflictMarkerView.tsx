import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { GitMerge } from 'lucide-react';

interface ConflictMarkerViewProps {
  file: string;
  content: string;
}

interface ParsedConflict {
  type: 'ours' | 'theirs' | 'separator' | 'normal';
  lines: string[];
  startLine: number;
}

/**
 * ConflictMarkerView - Display conflict markers with syntax highlighting
 * 
 * Parses git conflict markers (<<<<<<<, =======, >>>>>>>)
 * and displays them with color-coded sections.
 */
export function ConflictMarkerView({ file, content }: ConflictMarkerViewProps) {
  const parsed = parseConflictMarkers(content);

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="bg-zinc-100 dark:bg-zinc-800 px-3 py-2 border-b flex items-center gap-2">
        <GitMerge className="h-4 w-4" />
        <span className="text-sm font-medium">{file}</span>
        <Badge variant="outline" className="ml-auto">
          {parsed.filter(p => p.type === 'ours' || p.type === 'theirs').length / 2} conflict blocks
        </Badge>
      </div>

      {/* Conflict Content */}
      <ScrollArea className="h-96">
        <div className="font-mono text-xs">
          {parsed.map((block, blockIndex) => (
            <div key={blockIndex}>
              {block.type === 'ours' && (
                <div className="bg-blue-50 dark:bg-blue-950 border-l-4 border-blue-500">
                  <div className="px-3 py-1 text-blue-700 dark:text-blue-300 font-semibold text-xs border-b border-blue-200 dark:border-blue-900">
                    {'<<<<<<< HEAD (Main Branch)'}
                  </div>
                  {block.lines.map((line, i) => (
                    <div key={i} className="px-3 py-0.5 flex">
                      <span className="text-zinc-500 w-12 text-right mr-3 select-none">
                        {block.startLine + i}
                      </span>
                      <span className="text-blue-900 dark:text-blue-100">{line}</span>
                    </div>
                  ))}
                </div>
              )}

              {block.type === 'separator' && (
                <div className="bg-zinc-200 dark:bg-zinc-700 px-3 py-1 text-zinc-600 dark:text-zinc-400 font-semibold text-xs">
                  {'======='}
                </div>
              )}

              {block.type === 'theirs' && (
                <div className="bg-green-50 dark:bg-green-950 border-l-4 border-green-500">
                  {block.lines.map((line, i) => (
                    <div key={i} className="px-3 py-0.5 flex">
                      <span className="text-zinc-500 w-12 text-right mr-3 select-none">
                        {block.startLine + i}
                      </span>
                      <span className="text-green-900 dark:text-green-100">{line}</span>
                    </div>
                  ))}
                  <div className="px-3 py-1 text-green-700 dark:text-green-300 font-semibold text-xs border-t border-green-200 dark:border-green-900">
                    {'>>>>>>> run branch'}
                  </div>
                </div>
              )}

              {block.type === 'normal' && (
                <div>
                  {block.lines.map((line, i) => (
                    <div key={i} className="px-3 py-0.5 flex hover:bg-zinc-50 dark:hover:bg-zinc-900">
                      <span className="text-zinc-400 w-12 text-right mr-3 select-none">
                        {block.startLine + i}
                      </span>
                      <span className="text-zinc-700 dark:text-zinc-300">{line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * Parse git conflict markers into structured blocks
 */
function parseConflictMarkers(content: string): ParsedConflict[] {
  const lines = content.split('\n');
  const blocks: ParsedConflict[] = [];
  let currentBlock: ParsedConflict | null = null;
  let lineNum = 1;

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      // Start of "ours" section
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      currentBlock = {
        type: 'ours',
        lines: [],
        startLine: lineNum + 1,
      };
    } else if (line.startsWith('=======')) {
      // Separator between ours and theirs
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      blocks.push({
        type: 'separator',
        lines: [],
        startLine: lineNum,
      });
      currentBlock = {
        type: 'theirs',
        lines: [],
        startLine: lineNum + 1,
      };
    } else if (line.startsWith('>>>>>>>')) {
      // End of "theirs" section
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      currentBlock = {
        type: 'normal',
        lines: [],
        startLine: lineNum + 1,
      };
    } else {
      // Regular content line
      if (!currentBlock) {
        currentBlock = {
          type: 'normal',
          lines: [],
          startLine: lineNum,
        };
      }
      currentBlock.lines.push(line);
    }
    lineNum++;
  }

  if (currentBlock && currentBlock.lines.length > 0) {
    blocks.push(currentBlock);
  }

  return blocks;
}

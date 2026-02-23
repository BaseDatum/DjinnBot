import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileBox } from 'lucide-react';
import { fetchAgentSandbox, fetchAgentSandboxFile } from '@/lib/api';
import { SandboxInfo, SandboxFileContent } from '@/types/sandbox';
import { SandboxFileTree } from './SandboxFileTree';
import { InstalledToolsBadges } from './InstalledToolsBadges';
import { DiskUsageBar } from './DiskUsageBar';
import { FileViewer } from '../workspace/FileViewer';

interface SandboxExplorerProps {
  agentId: string;
}

export function SandboxExplorer({ agentId }: SandboxExplorerProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const {
    data: sandboxData,
    isLoading,
    error,
  } = useQuery<SandboxInfo>({
    queryKey: ['sandbox', agentId],
    queryFn: () => fetchAgentSandbox(agentId),
  });

  const { isLoading: fileLoading, data: fileData } = useQuery({
    queryKey: ['sandbox-file', agentId, selectedPath],
    queryFn: () => fetchAgentSandboxFile(agentId, selectedPath!),
    enabled: !!selectedPath,
  });

  const handleSelect = (path: string) => {
    setSelectedPath(path);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-zinc-500">
        Loading sandbox...
      </div>
    );
  }

  if (error || !sandboxData) {
    return (
      <div className="p-6 text-center">
        <div className="text-zinc-400 text-sm mb-2">⚠️ Sandbox not accessible</div>
        <div className="text-zinc-600 text-xs">
          {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    );
  }

  const hasFiles = sandboxData.rootFiles && sandboxData.rootFiles.length > 0;

  if (!hasFiles) {
    return (
      <div className="p-6 text-center">
        <FileBox className="h-12 w-12 mx-auto mb-3 text-zinc-700" />
        <div className="text-zinc-400 text-sm mb-2">Agent's personal sandbox is empty</div>
        <div className="text-zinc-600 text-xs space-y-1">
          <p>No files in the agent's persistent storage.</p>
          <p className="text-zinc-500">
            Note: Files created during pipeline runs are stored in the <strong>run workspace</strong>,
            not the agent's personal sandbox.
          </p>
        </div>
      </div>
    );
  }

  // Update file content when fileData changes
  const content = fileData
    ? fileData.binary
      ? `Binary file (${fileData.size} bytes)`
      : fileData.content || ''
    : '';

  return (
    <div className="space-y-4 p-4">
      {/* Installed Tools */}
      {sandboxData.installedTools.length > 0 && (
        <div className="bg-zinc-900/50 rounded-lg border border-zinc-800 p-3">
          <div className="text-xs font-medium text-zinc-400 mb-2">
            Installed Tools
          </div>
          <InstalledToolsBadges tools={sandboxData.installedTools} />
        </div>
      )}

      {/* File Browser */}
      <div className="bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
          <FileBox className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-xs font-medium text-zinc-400">
            Sandbox Filesystem
          </span>
        </div>

        {selectedPath ? (
          <div className="flex flex-col h-[500px]">
            <div className="flex-1 overflow-auto">
              {fileLoading ? (
                <div className="p-4 text-xs text-zinc-500">Loading...</div>
              ) : (
                <FileViewer path={selectedPath} content={content} />
              )}
            </div>
            <button
              onClick={() => setSelectedPath(null)}
              className="px-3 py-1.5 border-t border-zinc-800 text-xs text-zinc-500 hover:text-zinc-400 text-left"
            >
              ← Back to file list
            </button>
          </div>
        ) : (
          <div className="overflow-auto h-[500px]">
            <SandboxFileTree
              files={sandboxData.rootFiles}
              agentId={agentId}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              changedPaths={new Set()}
            />
          </div>
        )}
      </div>

      {/* Disk Usage */}
      <div className="bg-zinc-900/50 rounded-lg border border-zinc-800 p-3 space-y-2">
        <div className="text-xs font-medium text-zinc-400 mb-2">Disk Usage</div>
        <DiskUsageBar
          label="Sandbox Storage"
          used={sandboxData.diskUsage.used}
          total={sandboxData.diskUsage.total}
        />
      </div>
    </div>
  );
}
export interface ProjectMemory {
  projectId: string;
  content: string;
  updatedAt: number;
}

export interface AgentContext {
  projectMemory: string;
  progressFile: string;
  accumulatedOutputs: Record<string, string>;
  communications: CommunicationEntry[];
  resolvedInput: string;
  humanContext?: string;
}

export interface CommunicationEntry {
  from: string;
  to: string;
  message: string;
  threadId: string;
  timestamp: number;
}

export type MemoryTier = 'project' | 'run' | 'step';

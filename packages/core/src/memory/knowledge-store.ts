import type { KnowledgeEntry } from '../types/state.js';

interface Store {
  addKnowledge: (entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>) => KnowledgeEntry;
  getKnowledge: (runId: string, options?: { category?: string; importance?: string }) => KnowledgeEntry[];
}

export class KnowledgeStore {
  constructor(private store: Store) {}

  async share(
    runId: string,
    agentId: string,
    content: string,
    options?: {
      category?: string;
      importance?: 'low' | 'medium' | 'high' | 'critical';
    }
  ): Promise<void> {
    const category = options?.category ?? 'pattern';
    const importance = options?.importance ?? 'medium';

    // Map to valid KnowledgeEntry category type
    const validCategory = this.normalizeCategory(category);

    this.store.addKnowledge({
      runId,
      agentId,
      category: validCategory,
      content,
      importance,
    });
  }

  async getRelevant(
    runId: string,
    options?: {
      category?: string;
      minImportance?: string;
      agentId?: string;
    }
  ): Promise<Array<{ category: string; content: string; importance: string; agentId: string }>> {
    const entries = this.store.getKnowledge(runId, {
      category: options?.category,
    });

    let filtered = entries;

    // Filter by minimum importance if specified
    if (options?.minImportance) {
      const importanceOrder = ['low', 'medium', 'high', 'critical'];
      const minIndex = importanceOrder.indexOf(options.minImportance);
      
      if (minIndex !== -1) {
        filtered = entries.filter(entry => {
          const entryIndex = importanceOrder.indexOf(entry.importance);
          return entryIndex >= minIndex;
        });
      }
    }

    // Filter by agent if specified
    if (options?.agentId) {
      filtered = filtered.filter(entry => entry.agentId === options.agentId);
    }

    return filtered.map(entry => ({
      category: entry.category,
      content: entry.content,
      importance: entry.importance,
      agentId: entry.agentId,
    }));
  }

  async getAll(
    runId: string
  ): Promise<Array<{ category: string; content: string; importance: string; agentId: string }>> {
    const entries = await this.store.getKnowledge(runId);

    return entries.map(entry => ({
      category: entry.category,
      content: entry.content,
      importance: entry.importance,
      agentId: entry.agentId,
    }));
  }

  private normalizeCategory(category: string): 'pattern' | 'decision' | 'issue' | 'convention' {
    const validCategories = ['pattern', 'decision', 'issue', 'convention'];
    const normalized = category.toLowerCase();
    
    if (validCategories.includes(normalized)) {
      return normalized as 'pattern' | 'decision' | 'issue' | 'convention';
    }
    
    return 'pattern';
  }
}

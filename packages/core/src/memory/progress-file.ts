import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export interface ProgressEntry {
  timestamp: number;
  agentId: string;
  stepId: string;
  content: string;
  learnings?: string[];
}

export class ProgressFileManager {
  constructor(private dataDir: string) {}

  getPath(runId: string): string {
    return join(this.dataDir, 'progress', `${runId}.md`);
  }

  async read(runId: string): Promise<string> {
    const path = this.getPath(runId);
    try {
      return await readFile(path, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return '';
      }
      throw err;
    }
  }

  async append(runId: string, entry: ProgressEntry): Promise<void> {
    const path = this.getPath(runId);
    
    // Ensure directory exists before writing
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    
    const formattedEntry = this.formatEntry(entry);
    
    // Check if file exists to add header if new
    const exists = await this.fileExists(path);
    if (!exists) {
      const header = `# Run Progress: ${runId}\n\n`;
      await writeFile(path, header + formattedEntry, 'utf-8');
    } else {
      await appendFile(path, formattedEntry, 'utf-8');
    }
  }

  private formatEntry(entry: ProgressEntry): string {
    const date = new Date(entry.timestamp);
    const dateStr = date.toISOString().slice(0, 16).replace('T', ' ');
    
    let markdown = `## ${dateStr} - [${entry.agentId}] Step: ${entry.stepId}\n`;
    markdown += `${entry.content}\n`;
    
    if (entry.learnings && entry.learnings.length > 0) {
      markdown += `\n**Learnings:**\n`;
      for (const learning of entry.learnings) {
        markdown += `- ${learning}\n`;
      }
    }
    
    markdown += `---\n\n`;
    return markdown;
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}

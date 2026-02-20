/**
 * SkillRegistry — discovers, loads and serves agent skills.
 *
 * Skills are markdown files with optional YAML frontmatter stored in:
 *   agents/_skills/          (global — available to all agents)
 *   agents/<id>/skills/      (agent-specific — only for that agent)
 *
 * Skill file format:
 * ```
 * ---
 * name: github-pr
 * description: Opening and merging GitHub pull requests
 * tags: [github, git, pr, pull-request, merge]
 * enabled: true          # set to false to exclude from manifest
 * ---
 *
 * # GitHub PR Skill
 * ... full instructions ...
 * ```
 *
 * Skills with `enabled: false` are stored on disk but excluded from
 * the manifest injected into agent system prompts. This allows UI-driven
 * toggling without deleting files.
 */

import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  /** Slug derived from filename — used as the skill identifier */
  name: string;
  /** One-line description shown in the manifest */
  description: string;
  /** Keywords used for automatic pipeline keyword matching */
  tags: string[];
  /** Whether this skill appears in agent manifests. Defaults to true. */
  enabled: boolean;
  /** 'global' = agents/_skills/, 'agent' = agents/<id>/skills/ */
  scope: 'global' | 'agent';
  /** Set when scope === 'agent' */
  agentId?: string;
  /** Full markdown content (including frontmatter stripped) */
  content: string;
  /** Raw file content including frontmatter */
  raw: string;
  /** Absolute path to the skill file */
  filePath: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface CreateSkillOptions {
  name: string;
  description: string;
  tags?: string[];
  content: string;
  /** Defaults to 'global'. Pass agentId for agent-scoped skills. */
  scope?: 'global' | 'agent';
  agentId?: string;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse a skill markdown file — extract YAML frontmatter and body.
 * Frontmatter is delimited by leading/trailing `---` lines.
 */
function parseSkillFile(raw: string, filePath: string): Omit<SkillEntry, 'scope' | 'agentId' | 'filePath'> {
  const slug = basename(filePath, '.md');

  // Try to extract frontmatter
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);

  let frontmatter: SkillFrontmatter = {};
  let body = raw;

  if (fmMatch) {
    body = fmMatch[2].trim();
    // Minimal YAML parse — only handle simple key: value and key: [array]
    frontmatter = parseSimpleYaml(fmMatch[1]);
  }

  const name = frontmatter.name || slug;
  const description = frontmatter.description || `Skill: ${name}`;
  const tags = frontmatter.tags || [name];
  const enabled = frontmatter.enabled !== false; // default true

  return { name, description, tags, enabled, content: body, raw };
}

/**
 * Minimal YAML parser for skill frontmatter.
 * Handles: string values, boolean, and array literals like [a, b, c].
 */
function parseSimpleYaml(yaml: string): SkillFrontmatter {
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Array: [a, b, c]
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      result[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      continue;
    }

    // Boolean
    if (rawVal === 'true') { result[key] = true; continue; }
    if (rawVal === 'false') { result[key] = false; continue; }

    // String (strip optional quotes)
    result[key] = rawVal.replace(/^['"]|['"]$/g, '');
  }

  return result as SkillFrontmatter;
}

/**
 * Serialize a SkillEntry back to a file string with frontmatter.
 */
export function serializeSkill(opts: CreateSkillOptions): string {
  const tags = opts.tags?.length ? `[${opts.tags.join(', ')}]` : `[${opts.name}]`;
  const fm = [
    '---',
    `name: ${opts.name}`,
    `description: ${opts.description}`,
    `tags: ${tags}`,
    `enabled: true`,
    '---',
    '',
  ].join('\n');

  return fm + opts.content;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class SkillRegistry {
  private globalSkillsDir: string;

  constructor(private agentsDir: string) {
    this.globalSkillsDir = join(agentsDir, '_skills');
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  /**
   * Load all global skills from agents/_skills/.
   * Returns all skills regardless of enabled state.
   */
  async getGlobalSkills(): Promise<SkillEntry[]> {
    return this.loadSkillsFromDir(this.globalSkillsDir, 'global');
  }

  /**
   * Load agent-specific skills from agents/<id>/skills/.
   */
  async getAgentSkills(agentId: string): Promise<SkillEntry[]> {
    const dir = join(this.agentsDir, agentId, 'skills');
    return this.loadSkillsFromDir(dir, 'agent', agentId);
  }

  /**
   * Get all skills visible to an agent — global + agent-specific, deduped.
   * Agent-specific skills override globals with the same name.
   * Respects the `disabledSkills` list from the agent's config.
   */
  async getForAgent(agentId: string, disabledSkills: string[] = []): Promise<SkillEntry[]> {
    const [global, agentSpecific] = await Promise.all([
      this.getGlobalSkills(),
      this.getAgentSkills(agentId),
    ]);

    // Merge: agent-specific overrides global by name
    const merged = new Map<string, SkillEntry>();
    for (const skill of global) {
      merged.set(skill.name, skill);
    }
    for (const skill of agentSpecific) {
      merged.set(skill.name, skill);
    }

    const disabledSet = new Set(disabledSkills.map(s => s.toLowerCase()));

    return Array.from(merged.values()).filter(skill => {
      // Exclude if globally disabled (enabled: false in frontmatter)
      if (!skill.enabled) return false;
      // Exclude if disabled in agent config
      if (disabledSet.has(skill.name.toLowerCase())) return false;
      return true;
    });
  }

  // ── Manifest ─────────────────────────────────────────────────────────────────

  /**
   * Build the compact manifest string injected into every system prompt.
   * Only includes enabled skills.
   */
  buildManifest(skills: SkillEntry[]): string {
    if (skills.length === 0) return '';

    const lines = skills.map(s => `- **${s.name}**: ${s.description}`);
    return [
      '# SKILLS',
      '',
      'You have specialized skills available. Call `load_skill("name")` to load full',
      'instructions for a skill when you need it. Skills are loaded on demand.',
      '',
      ...lines,
    ].join('\n');
  }

  /**
   * Match skills by keyword overlap between skill tags/name and arbitrary text.
   * Returns skills whose tags appear in the text (case-insensitive).
   * Used to proactively inject skill bodies for pipeline steps.
   */
  matchByKeywords(skills: SkillEntry[], text: string): SkillEntry[] {
    const lowerText = text.toLowerCase();
    return skills.filter(skill => {
      const keywords = [skill.name, ...skill.tags].map(k => k.toLowerCase());
      return keywords.some(kw => lowerText.includes(kw));
    });
  }

  // ── Lookup ───────────────────────────────────────────────────────────────────

  /**
   * Get a skill by name for a specific agent (searches agent + global).
   * Returns null if not found.
   */
  async getByName(name: string, agentId: string): Promise<SkillEntry | null> {
    // Check agent-specific first
    const agentDir = join(this.agentsDir, agentId, 'skills');
    const agentPath = join(agentDir, `${name}.md`);
    if (existsSync(agentPath)) {
      const skills = await this.loadSkillsFromDir(agentDir, 'agent', agentId);
      return skills.find(s => s.name === name) ?? null;
    }

    // Fall back to global
    const globalPath = join(this.globalSkillsDir, `${name}.md`);
    if (existsSync(globalPath)) {
      const skills = await this.loadSkillsFromDir(this.globalSkillsDir, 'global');
      return skills.find(s => s.name === name) ?? null;
    }

    return null;
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /**
   * Write a new skill file to disk. Creates the directory if needed.
   * Returns the created SkillEntry.
   */
  async createSkill(opts: CreateSkillOptions): Promise<SkillEntry> {
    const slug = opts.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    let dir: string;
    let scope: 'global' | 'agent';
    let agentId: string | undefined;

    if (opts.scope === 'agent' && opts.agentId) {
      dir = join(this.agentsDir, opts.agentId, 'skills');
      scope = 'agent';
      agentId = opts.agentId;
    } else {
      dir = this.globalSkillsDir;
      scope = 'global';
    }

    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${slug}.md`);
    const raw = serializeSkill({ ...opts, name: slug });
    await writeFile(filePath, raw, 'utf8');

    return {
      name: slug,
      description: opts.description,
      tags: opts.tags ?? [slug],
      enabled: true,
      scope,
      agentId,
      content: opts.content,
      raw,
      filePath,
    };
  }

  /**
   * Update an existing skill file. Preserves the enabled state unless explicitly provided.
   */
  async updateSkill(
    name: string,
    updates: Partial<Omit<CreateSkillOptions, 'name' | 'scope' | 'agentId'>> & { enabled?: boolean },
    agentId?: string,
  ): Promise<SkillEntry> {
    const existing = agentId
      ? await this.getByName(name, agentId)
      : (await this.getGlobalSkills()).find(s => s.name === name) ?? null;

    if (!existing) throw new Error(`Skill "${name}" not found`);

    const updated: CreateSkillOptions = {
      name: existing.name,
      description: updates.description ?? existing.description,
      tags: updates.tags ?? existing.tags,
      content: updates.content ?? existing.content,
      scope: existing.scope,
      agentId: existing.agentId,
    };

    const enabled = updates.enabled !== undefined ? updates.enabled : existing.enabled;
    const raw = serializeSkill(updated).replace('enabled: true', `enabled: ${enabled}`);
    await writeFile(existing.filePath, raw, 'utf8');

    return { ...existing, ...updated, enabled, raw };
  }

  /**
   * Delete a skill file.
   */
  async deleteSkill(name: string, agentId?: string): Promise<void> {
    const skill = agentId
      ? await this.getByName(name, agentId)
      : (await this.getGlobalSkills()).find(s => s.name === name) ?? null;

    if (!skill) throw new Error(`Skill "${name}" not found`);
    await unlink(skill.filePath);
  }

  /**
   * Toggle the enabled state of a skill (include/exclude from manifest).
   */
  async setEnabled(name: string, enabled: boolean, agentId?: string): Promise<void> {
    await this.updateSkill(name, { enabled }, agentId);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async loadSkillsFromDir(
    dir: string,
    scope: 'global' | 'agent',
    agentId?: string,
  ): Promise<SkillEntry[]> {
    try {
      await stat(dir); // throws if not found
    } catch {
      return [];
    }

    const entries = await readdir(dir, { withFileTypes: true });
    const skills: SkillEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = join(dir, entry.name);
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = parseSkillFile(raw, filePath);
        skills.push({ ...parsed, scope, agentId, filePath });
      } catch (err) {
        console.warn(`[SkillRegistry] Failed to parse ${filePath}:`, err);
      }
    }

    return skills;
  }
}

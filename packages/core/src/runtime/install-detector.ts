export interface DetectedInstall {
  ecosystem: string; // 'python' | 'npm' | 'go'
  package: string;
  version?: string;
}

/**
 * Detects package installations from command output.
 * Pure function - no side effects.
 */
export function detectInstallations(command: string, output: string): DetectedInstall[] {
  const installs: DetectedInstall[] = [];

  // Detect pip install
  const pipMatch = command.match(/pip3?\s+install\s+(?:-[^\s]+\s+)*(\S+)/);
  if (pipMatch && output.includes('Successfully installed')) {
    installs.push({ ecosystem: 'python', package: pipMatch[1] });
  }

  // Detect npm install -g
  const npmGlobalMatch = command.match(/npm\s+install\s+-g\s+(\S+)/);
  if (npmGlobalMatch && !output.includes('ERR!')) {
    installs.push({ ecosystem: 'npm', package: npmGlobalMatch[1] });
  }

  // Detect go install
  const goMatch = command.match(/go\s+install\s+(\S+)/);
  if (goMatch && !output.includes('cannot find') && !output.includes('error')) {
    installs.push({ ecosystem: 'go', package: goMatch[1] });
  }

  return installs;
}

/**
 * Formats a detected install into a tool name string.
 */
export function formatToolName(install: DetectedInstall): string {
  return `${install.ecosystem}:${install.package}`;
}
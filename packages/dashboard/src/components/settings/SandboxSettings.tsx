import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SandboxConfig, SANDBOX_LIMITS } from '@/types/config';
import { Input } from '@/components/ui/input';

interface SandboxSettingsProps {
  config: SandboxConfig;
  onChange: (config: SandboxConfig) => void;
  disabled?: boolean;
}

export function SandboxSettings({ config, onChange, disabled }: SandboxSettingsProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validateField = (key: keyof SandboxConfig, value: number | boolean): string | null => {
    if (typeof value === 'boolean') return null;
    
    const limits = SANDBOX_LIMITS[key as keyof typeof SANDBOX_LIMITS];
    if ('min' in limits && 'max' in limits) {
      if (value < limits.min) return `Minimum is ${limits.min}`;
      if (value > limits.max) return `Maximum is ${limits.max}`;
    }
    return null;
  };

  const handleNumberChange = (key: keyof SandboxConfig, valueStr: string) => {
    const value = parseInt(valueStr, 10);
    if (isNaN(value)) return;
    
    const error = validateField(key, value);
    setErrors(prev => ({
      ...prev,
      [key]: error || ''
    }));
    
    if (!error) {
      onChange({ ...config, [key]: value });
    }
  };

  const handleCheckboxChange = (key: keyof SandboxConfig, checked: boolean) => {
    onChange({ ...config, [key]: checked });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Sandbox Resources</h3>
        
        {/* Warning */}
        <div className="flex items-start gap-2 p-3 bg-amber-950/20 border border-amber-900/30 rounded-md mb-4">
          <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-200">
            Changes take effect on next agent execution. Active sessions use existing limits.
          </p>
        </div>
      </div>

      {/* Memory Limit */}
      <div className="space-y-2">
        <label htmlFor="memory_mb" className="text-xs font-medium text-zinc-400">
          Memory Limit (MB)
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="memory_mb"
            type="number"
            value={config.memory_mb}
            onChange={(e) => handleNumberChange('memory_mb', e.target.value)}
            min={SANDBOX_LIMITS.memory_mb.min}
            max={SANDBOX_LIMITS.memory_mb.max}
            step={256}
            disabled={disabled}
            className="flex-1 font-mono"
          />
          <span className="text-xs text-zinc-600 whitespace-nowrap">
            {SANDBOX_LIMITS.memory_mb.min} - {SANDBOX_LIMITS.memory_mb.max}
          </span>
        </div>
        {errors.memory_mb && (
          <p className="text-xs text-red-400">{errors.memory_mb}</p>
        )}
      </div>

      {/* CPU Cores */}
      <div className="space-y-2">
        <label htmlFor="cpu_cores" className="text-xs font-medium text-zinc-400">
          CPU Cores
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="cpu_cores"
            type="number"
            value={config.cpu_cores}
            onChange={(e) => handleNumberChange('cpu_cores', e.target.value)}
            min={SANDBOX_LIMITS.cpu_cores.min}
            max={SANDBOX_LIMITS.cpu_cores.max}
            disabled={disabled}
            className="flex-1 font-mono"
          />
          <span className="text-xs text-zinc-600 whitespace-nowrap">
            {SANDBOX_LIMITS.cpu_cores.min} - {SANDBOX_LIMITS.cpu_cores.max}
          </span>
        </div>
        {errors.cpu_cores && (
          <p className="text-xs text-red-400">{errors.cpu_cores}</p>
        )}
      </div>

      {/* Max Processes */}
      <div className="space-y-2">
        <label htmlFor="max_procs" className="text-xs font-medium text-zinc-400">
          Max Processes
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="max_procs"
            type="number"
            value={config.max_procs}
            onChange={(e) => handleNumberChange('max_procs', e.target.value)}
            min={SANDBOX_LIMITS.max_procs.min}
            max={SANDBOX_LIMITS.max_procs.max}
            disabled={disabled}
            className="flex-1 font-mono"
          />
          <span className="text-xs text-zinc-600 whitespace-nowrap">
            {SANDBOX_LIMITS.max_procs.min} - {SANDBOX_LIMITS.max_procs.max}
          </span>
        </div>
        {errors.max_procs && (
          <p className="text-xs text-red-400">{errors.max_procs}</p>
        )}
      </div>

      {/* Command Timeout */}
      <div className="space-y-2">
        <label htmlFor="timeout_seconds" className="text-xs font-medium text-zinc-400">
          Command Timeout (seconds)
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="timeout_seconds"
            type="number"
            value={config.timeout_seconds}
            onChange={(e) => handleNumberChange('timeout_seconds', e.target.value)}
            min={SANDBOX_LIMITS.timeout_seconds.min}
            max={SANDBOX_LIMITS.timeout_seconds.max}
            disabled={disabled}
            className="flex-1 font-mono"
          />
          <span className="text-xs text-zinc-600 whitespace-nowrap">
            {SANDBOX_LIMITS.timeout_seconds.min} - {SANDBOX_LIMITS.timeout_seconds.max}
          </span>
        </div>
        {errors.timeout_seconds && (
          <p className="text-xs text-red-400">{errors.timeout_seconds}</p>
        )}
        <p className="text-xs text-zinc-600">
          Max duration for a single command execution
        </p>
      </div>

      {/* Network Access */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="network"
            checked={config.network}
            onChange={(e) => handleCheckboxChange('network', e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 bg-zinc-900 border border-zinc-700 rounded text-blue-500 focus:ring-1 focus:ring-blue-500 focus:ring-offset-0 disabled:opacity-50"
          />
          <label htmlFor="network" className="text-xs font-medium text-zinc-400 cursor-pointer">
            Enable Network Access
          </label>
        </div>
        <p className="text-xs text-zinc-600 ml-7">
          Allow outbound network connections from sandbox
        </p>
      </div>
    </div>
  );
}

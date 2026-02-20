interface DiskUsageBarProps {
  label: string;
  used: number;
  total: number | null;
  unit?: string;  // Optional unit prop, default to 'MB'
}

export function DiskUsageBar({ label, used, total, unit = 'MB' }: DiskUsageBarProps) {
  const percentage = total ? (used / total) * 100 : 0;
  const totalStr = total !== null ? `${total} ${unit}` : 'unknown';

  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="text-xs text-zinc-500">{used} {unit} / {totalStr}</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all"
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  );
}

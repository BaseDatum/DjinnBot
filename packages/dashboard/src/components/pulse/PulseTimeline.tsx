import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Activity, AlertTriangle, ChevronDown, ChevronRight, RefreshCw, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { fetchPulseTimeline, autoSpreadOffsets } from '@/lib/api';

interface ScheduledPulse {
  agentId: string;
  scheduledAt: number;
  source: 'recurring' | 'one-off';
  status: string;
  routineId?: string | null;
  routineName?: string | null;
  routineColor?: string | null;
}

interface PulseConflict {
  windowStart: number;
  windowEnd: number;
  agents: Array<{ agentId: string; scheduledAt: number; source: string }>;
  severity: 'warning' | 'critical';
}

interface TimelineData {
  windowStart: number;
  windowEnd: number;
  pulses: ScheduledPulse[];
  conflicts: PulseConflict[];
  summary: {
    totalPulses: number;
    byAgent: Record<string, number>;
    conflictCount: number;
  };
}

// Agent colors for visual distinction
const AGENT_COLORS: Record<string, string> = {
  finn: '#3B82F6',     // blue
  eric: '#10B981',     // green
  yang: '#F59E0B',     // amber
  chieko: '#EC4899',   // pink
  stas: '#8B5CF6',     // violet
  luke: '#6366F1',     // indigo
  holt: '#EF4444',     // red
  jim: '#14B8A6',      // teal
  shigeo: '#F97316',   // orange
  yukihiro: '#84CC16', // lime
};

const DEFAULT_COLOR = '#6B7280'; // gray

function getAgentColor(agentId: string): string {
  return AGENT_COLORS[agentId] || DEFAULT_COLOR;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit',
  });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = timestamp - now;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  
  if (minutes < 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${hours}h ${minutes % 60}m`;
}

interface PulseTimelineProps {
  hours?: number;
  showHeader?: boolean;
  className?: string;
}

export function PulseTimeline({ hours = 24, showHeader = true, className = '' }: PulseTimelineProps) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [spreading, setSpreading] = useState(false);
  const [nextPulsesExpanded, setNextPulsesExpanded] = useState(false);

  useEffect(() => {
    loadTimeline();
    
    // Refresh every 5 minutes
    const interval = setInterval(loadTimeline, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [hours]);

  const loadTimeline = async () => {
    try {
      const timeline = await fetchPulseTimeline(hours);
      setData(timeline);
    } catch (error) {
      console.error('Failed to load pulse timeline:', error);
      toast.error('Failed to load pulse timeline');
    } finally {
      setLoading(false);
    }
  };

  const handleAutoSpread = async () => {
    setSpreading(true);
    try {
      const result = await autoSpreadOffsets();
      toast.success(`Spread offsets for ${Object.keys(result.changes).length} agents`);
      loadTimeline();
    } catch (error) {
      toast.error('Failed to auto-spread offsets');
    } finally {
      setSpreading(false);
    }
  };

  // Calculate position percentage for a pulse within the timeline
  const getPulsePosition = (timestamp: number): number => {
    if (!data) return 0;
    const totalDuration = data.windowEnd - data.windowStart;
    const elapsed = timestamp - data.windowStart;
    return (elapsed / totalDuration) * 100;
  };

  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className={className}>
        <CardContent className="py-8 text-center text-muted-foreground">
          Failed to load timeline
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      {showHeader && (
        <CardHeader className="pb-2 px-3 sm:px-6">
          {/* Mobile: Stack vertically */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Activity className="h-5 w-5 shrink-0" />
              <CardTitle className="text-base sm:text-lg">Pulse Timeline</CardTitle>
              <Badge variant="secondary" className="text-xs">{data.summary.totalPulses} pulses</Badge>
              {data.summary.conflictCount > 0 && (
                <Badge variant="destructive" className="flex items-center gap-1 text-xs">
                  <AlertTriangle className="h-3 w-3" />
                  {data.summary.conflictCount} conflicts
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {data.summary.conflictCount > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAutoSpread}
                  disabled={spreading}
                  className="text-xs h-8"
                >
                  <Wand2 className="h-3 w-3 sm:mr-1" />
                  <span className="hidden sm:inline">{spreading ? 'Spreading...' : 'Auto-Spread'}</span>
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={loadTimeline} className="h-8 w-8 p-0">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
      )}
      
      <CardContent className="px-3 sm:px-6">
        {/* Timeline visualization */}
        <div className="relative">
          {/* Time axis */}
          <div className="flex justify-between text-xs text-muted-foreground mb-2">
            <span>Now</span>
            <span>{hours}h</span>
          </div>
          
          {/* Main timeline bar - horizontally scrollable on mobile */}
          <div className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0">
            <div className="relative h-12 bg-muted/50 rounded-lg overflow-hidden min-w-[300px]">
            {/* Hour markers */}
            {Array.from({ length: hours + 1 }, (_, i) => (
              <div
                key={i}
                className="absolute top-0 bottom-0 w-px bg-border/50"
                style={{ left: `${(i / hours) * 100}%` }}
              />
            ))}
            
            {/* Conflict zones */}
            {data.conflicts.map((conflict, idx) => {
              const startPos = getPulsePosition(conflict.windowStart);
              const endPos = getPulsePosition(conflict.windowEnd);
              return (
                <div
                  key={idx}
                  className={`absolute top-0 bottom-0 ${
                    conflict.severity === 'critical' 
                      ? 'bg-destructive/20' 
                      : 'bg-yellow-500/20'
                  }`}
                  style={{
                    left: `${startPos}%`,
                    width: `${Math.max(endPos - startPos, 1)}%`,
                  }}
                />
              );
            })}
            
            {/* Pulse dots */}
            <TooltipProvider>
              {data.pulses.map((pulse, idx) => {
                const pos = getPulsePosition(pulse.scheduledAt);
                // Use routine color if available, otherwise fall back to agent color
                const color = pulse.routineColor || getAgentColor(pulse.agentId);
                
                return (
                  <Tooltip key={idx}>
                    <TooltipTrigger asChild>
                      <button
                        className={`absolute w-3 h-3 rounded-full -translate-x-1/2 top-1/2 -translate-y-1/2 
                          hover:scale-150 transition-transform cursor-pointer
                          ${pulse.source === 'one-off' ? 'ring-2 ring-white' : ''}`}
                        style={{
                          left: `${pos}%`,
                          backgroundColor: color,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-sm">
                        <p className="font-medium">{pulse.agentId}</p>
                        {pulse.routineName && (
                          <p className="text-xs flex items-center gap-1">
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{ backgroundColor: pulse.routineColor || color }}
                            />
                            {pulse.routineName}
                          </p>
                        )}
                        <p className="text-muted-foreground">
                          {formatTime(pulse.scheduledAt)} ({formatRelativeTime(pulse.scheduledAt)})
                        </p>
                        <p className="text-xs">
                          {pulse.source === 'one-off' ? '★ One-off' : '● Recurring'}
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </TooltipProvider>
            
            {/* Current time marker */}
            <div 
              className="absolute top-0 bottom-0 w-0.5 bg-primary"
              style={{ left: '0%' }}
            >
              <div className="absolute -top-1 -left-1 w-2 h-2 bg-primary rounded-full" />
            </div>
            </div>
          </div>
          
          {/* Legend - scrollable on mobile */}
          <div className="flex flex-wrap gap-2 sm:gap-3 mt-4">
            {Object.entries(data.summary.byAgent).map(([agentId, count]) => (
              <div key={agentId} className="flex items-center gap-1 sm:gap-1.5 text-[10px] sm:text-xs">
                <div 
                  className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: getAgentColor(agentId) }}
                />
                <span className="truncate">{agentId}</span>
                <span className="text-muted-foreground">({count})</span>
              </div>
            ))}
          </div>
        </div>
        
        {/* Upcoming pulses list */}
        <div className="mt-4 sm:mt-6">
          <button
            className="flex items-center gap-1 text-sm font-medium mb-2 hover:text-foreground/80 transition-colors"
            onClick={() => setNextPulsesExpanded(prev => !prev)}
          >
            {nextPulsesExpanded
              ? <ChevronDown className="h-4 w-4 shrink-0" />
              : <ChevronRight className="h-4 w-4 shrink-0" />
            }
            Next Pulses
          </button>
          {nextPulsesExpanded && (
            <div className="space-y-1">
              {data.pulses.slice(0, 8).map((pulse, idx) => (
                <div 
                  key={idx}
                  className="flex items-center justify-between text-xs sm:text-sm py-1.5 px-2 rounded hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div 
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: pulse.routineColor || getAgentColor(pulse.agentId) }}
                    />
                    <span className="font-medium truncate">{pulse.agentId}</span>
                    {pulse.routineName && (
                      <span className="text-muted-foreground truncate text-[10px] sm:text-xs">
                        {pulse.routineName}
                      </span>
                    )}
                    {pulse.source === 'one-off' && (
                      <Badge variant="outline" className="text-[10px] px-1 shrink-0">one-off</Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground text-right shrink-0 ml-2">
                    <span className="hidden sm:inline">{formatTime(pulse.scheduledAt)} • </span>
                    <span>{formatRelativeTime(pulse.scheduledAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

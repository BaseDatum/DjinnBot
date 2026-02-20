import { useState, useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { 
  Clock, 
  Plus, 
  Trash2, 
  Calendar,
  Moon,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { 
  fetchAgentPulseSchedule, 
  updateAgentPulseSchedule, 
  addOneOffPulse, 
  removeOneOffPulse 
} from '@/lib/api';

interface PulseBlackout {
  type: 'recurring' | 'one-off';
  label?: string;
  startTime?: string;
  endTime?: string;
  daysOfWeek?: number[];
  start?: string;
  end?: string;
}

interface PulseSchedule {
  enabled: boolean;
  intervalMinutes: number;
  offsetMinutes: number;
  blackouts: PulseBlackout[];
  oneOffs: string[];
  maxConsecutiveSkips: number;
}

interface UpcomingPulse {
  agentId: string;
  scheduledAt: number;
  source: 'recurring' | 'one-off';
  status: string;
}

interface PulseScheduleEditorProps {
  agentId: string;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = timestamp - now;
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  
  if (diff < 0) return 'passed';
  if (hours > 24) return `in ${Math.floor(hours / 24)}d`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

export function PulseScheduleEditor({ agentId }: PulseScheduleEditorProps) {
  const [schedule, setSchedule] = useState<PulseSchedule | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingPulse[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // One-off pulse state
  const [newOneOffDate, setNewOneOffDate] = useState('');
  const [newOneOffTime, setNewOneOffTime] = useState('');
  const [addingOneOff, setAddingOneOff] = useState(false);
  
  // Blackout state
  const [showAddBlackout, setShowAddBlackout] = useState(false);
  const [newBlackoutStart, setNewBlackoutStart] = useState('22:00');
  const [newBlackoutEnd, setNewBlackoutEnd] = useState('07:00');
  const [newBlackoutLabel, setNewBlackoutLabel] = useState('');

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Only true when a change came from the user, not from loadSchedule writing state.
  const userEditing = useRef(false);
  // Always-current copy of schedule for the debounced save closure.
  const scheduleRef = useRef<PulseSchedule | null>(null);

  useEffect(() => {
    loadSchedule();
  }, [agentId]);

  // Auto-save with 800ms debounce — only fires when userEditing is set.
  useEffect(() => {
    if (!userEditing.current || !schedule) return;
    userEditing.current = false;

    scheduleRef.current = schedule;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');

    saveTimer.current = setTimeout(async () => {
      const s = scheduleRef.current;
      if (!s) return;
      try {
        await updateAgentPulseSchedule(agentId, {
          enabled: s.enabled,
          intervalMinutes: s.intervalMinutes,
          offsetMinutes: s.offsetMinutes,
          blackouts: s.blackouts,
        });
        setSaveState('saved');
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setSaveState('idle'), 2000);
        // Refresh upcoming pulses without touching schedule state.
        fetchAgentPulseSchedule(agentId)
          .then((data) => setUpcoming(data.upcoming))
          .catch(() => {});
      } catch {
        toast.error('Failed to save schedule');
        setSaveState('idle');
      }
    }, 800);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [schedule]);

  const loadSchedule = async () => {
    try {
      const data = await fetchAgentPulseSchedule(agentId);
      setSchedule(data.schedule);
      setUpcoming(data.upcoming);
    } catch (error) {
      console.error('Failed to load schedule:', error);
      toast.error('Failed to load pulse schedule');
    } finally {
      setLoading(false);
    }
  };

  const handleAddOneOff = async () => {
    if (!newOneOffDate || !newOneOffTime) {
      toast.error('Please select a date and time');
      return;
    }
    
    setAddingOneOff(true);
    try {
      const timestamp = new Date(`${newOneOffDate}T${newOneOffTime}`).toISOString();
      await addOneOffPulse(agentId, timestamp);
      toast.success('One-off pulse added');
      setNewOneOffDate('');
      setNewOneOffTime('');
      loadSchedule();
    } catch {
      toast.error('Failed to add pulse');
    } finally {
      setAddingOneOff(false);
    }
  };

  const handleRemoveOneOff = async (timestamp: string) => {
    try {
      await removeOneOffPulse(agentId, timestamp);
      toast.success('Pulse removed');
      loadSchedule();
    } catch {
      toast.error('Failed to remove pulse');
    }
  };

  const handleAddBlackout = () => {
    if (!schedule) return;
    
    const newBlackout: PulseBlackout = {
      type: 'recurring',
      label: newBlackoutLabel || 'Blackout',
      startTime: newBlackoutStart,
      endTime: newBlackoutEnd,
    };
    
    userEditing.current = true;
    setSchedule({ ...schedule, blackouts: [...schedule.blackouts, newBlackout] });
    setShowAddBlackout(false);
    setNewBlackoutLabel('');
    setNewBlackoutStart('22:00');
    setNewBlackoutEnd('07:00');
  };

  const handleRemoveBlackout = (index: number) => {
    if (!schedule) return;
    const newBlackouts = [...schedule.blackouts];
    newBlackouts.splice(index, 1);
    userEditing.current = true;
    setSchedule({ ...schedule, blackouts: newBlackouts });
  };

  const updateScheduleField = (field: keyof PulseSchedule, value: any) => {
    if (!schedule) return;
    userEditing.current = true;
    setSchedule({ ...schedule, [field]: value });
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!schedule) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Failed to load schedule
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Main Schedule Card */}
      <Card>
        <CardHeader className="pb-3 px-3 sm:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 sm:h-5 sm:w-5" />
              <CardTitle className="text-base sm:text-lg">Pulse Schedule</CardTitle>
            </div>
            <div className="flex items-center gap-3">
              {saveState === 'saving' && (
                <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>
              )}
              {saveState === 'saved' && (
                <span className="text-xs text-green-500">&#x2713; Saved</span>
              )}
              <Label htmlFor="pulse-enabled" className="text-xs sm:text-sm">Enabled</Label>
              <Switch
                id="pulse-enabled"
                checked={schedule.enabled}
                onCheckedChange={(checked) => updateScheduleField('enabled', checked)}
              />
            </div>
          </div>
        </CardHeader>
        
        <CardContent className="space-y-4 sm:space-y-6 px-3 sm:px-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div>
              <Label htmlFor="interval" className="text-sm">Interval (minutes)</Label>
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-1 sm:mb-2">
                Time between pulses
              </p>
              <Input
                id="interval"
                type="number"
                inputMode="numeric"
                min={5}
                max={1440}
                value={schedule.intervalMinutes}
                onChange={(e) => updateScheduleField('intervalMinutes', parseInt(e.target.value) || 30)}
                className="h-9"
              />
            </div>
            <div>
              <Label htmlFor="offset" className="text-sm">Offset (minutes)</Label>
              <p className="text-[10px] sm:text-xs text-muted-foreground mb-1 sm:mb-2">
                Minutes past the hour
              </p>
              <Input
                id="offset"
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                value={schedule.offsetMinutes}
                onChange={(e) => updateScheduleField('offsetMinutes', parseInt(e.target.value) || 0)}
                className="h-9"
              />
            </div>
          </div>
          
          <p className="text-xs text-muted-foreground">
            With interval {schedule.intervalMinutes}min and offset {schedule.offsetMinutes}min, 
            this agent pulses at :{schedule.offsetMinutes.toString().padStart(2, '0')}, 
            :{((schedule.offsetMinutes + schedule.intervalMinutes) % 60).toString().padStart(2, '0')}, etc.
          </p>
        </CardContent>
      </Card>

      {/* One-Off Pulses */}
      <Card>
        <CardHeader className="pb-3 px-3 sm:px-6">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 sm:h-5 sm:w-5" />
            <CardTitle className="text-base sm:text-lg">One-Off Pulses</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 sm:space-y-4 px-3 sm:px-6">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex gap-2 flex-1">
              <Input
                type="date"
                value={newOneOffDate}
                onChange={(e) => setNewOneOffDate(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                className="flex-1 h-9"
              />
              <Input
                type="time"
                value={newOneOffTime}
                onChange={(e) => setNewOneOffTime(e.target.value)}
                className="w-24 sm:w-32 h-9"
              />
            </div>
            <Button 
              onClick={handleAddOneOff}
              disabled={addingOneOff || !newOneOffDate || !newOneOffTime}
              size="sm"
              className="h-9 sm:w-auto w-full"
            >
              {addingOneOff ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4 mr-1" /> Add</>}
            </Button>
          </div>
          
          {schedule.oneOffs.length > 0 ? (
            <div className="space-y-2">
              {schedule.oneOffs.map((timestamp) => (
                <div 
                  key={timestamp}
                  className="flex items-center justify-between p-2 rounded bg-muted/50 gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="text-[10px] shrink-0">★</Badge>
                    <span className="text-xs sm:text-sm truncate">
                      {new Date(timestamp).toLocaleString()}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveOneOff(timestamp)}
                    className="h-8 w-8 p-0 shrink-0"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs sm:text-sm text-muted-foreground text-center py-3 sm:py-4">
              No scheduled one-off pulses
            </p>
          )}
        </CardContent>
      </Card>

      {/* Blackout Windows */}
      <Card>
        <CardHeader className="pb-3 px-3 sm:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Moon className="h-4 w-4 sm:h-5 sm:w-5" />
              <CardTitle className="text-base sm:text-lg">Blackout Windows</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddBlackout(!showAddBlackout)}
              className="h-8"
            >
              <Plus className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Add</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 sm:space-y-4 px-3 sm:px-6">
          {showAddBlackout && (
            <div className="p-3 sm:p-4 rounded-lg border bg-muted/30 space-y-3">
              <div>
                <Label className="text-sm">Label (optional)</Label>
                <Input
                  placeholder="e.g., Nighttime, Weekend"
                  value={newBlackoutLabel}
                  onChange={(e) => setNewBlackoutLabel(e.target.value)}
                  className="h-9 mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:gap-3">
                <div>
                  <Label className="text-sm">Start Time</Label>
                  <Input
                    type="time"
                    value={newBlackoutStart}
                    onChange={(e) => setNewBlackoutStart(e.target.value)}
                    className="h-9 mt-1"
                  />
                </div>
                <div>
                  <Label className="text-sm">End Time</Label>
                  <Input
                    type="time"
                    value={newBlackoutEnd}
                    onChange={(e) => setNewBlackoutEnd(e.target.value)}
                    className="h-9 mt-1"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleAddBlackout} size="sm" className="flex-1 sm:flex-none">
                  Add Blackout
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddBlackout(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          
          {schedule.blackouts.length > 0 ? (
            <div className="space-y-2">
              {schedule.blackouts.map((blackout, idx) => (
                <div 
                  key={idx}
                  className="flex items-center justify-between p-3 rounded bg-muted/50"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <Moon className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">
                        {blackout.label || 'Blackout'}
                      </span>
                      <Badge variant="secondary" className="text-xs">
                        {blackout.type}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {blackout.startTime && blackout.endTime 
                        ? `${blackout.startTime} - ${blackout.endTime}`
                        : blackout.start && blackout.end
                        ? `${new Date(blackout.start).toLocaleString()} - ${new Date(blackout.end).toLocaleString()}`
                        : 'Invalid blackout'
                      }
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveBlackout(idx)}
                    className="h-8 w-8 p-0"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No blackout windows configured
            </p>
          )}
        </CardContent>
      </Card>

      {/* Upcoming Pulses Preview */}
      <Card>
        <CardHeader className="pb-3 px-3 sm:px-6">
          <CardTitle className="text-base sm:text-lg">Upcoming Pulses (48h)</CardTitle>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {upcoming.length > 0 ? (
            <div className="space-y-1 max-h-48 sm:max-h-64 overflow-y-auto">
              {upcoming.map((pulse, idx) => (
                <div 
                  key={idx}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 ${pulse.source === 'one-off' ? 'text-amber-500' : 'text-muted-foreground'}`}>
                      {pulse.source === 'one-off' ? '★' : '●'}
                    </span>
                    <span className="text-xs sm:text-sm truncate">{formatDate(pulse.scheduledAt)}</span>
                  </div>
                  <span className="text-[10px] sm:text-xs text-muted-foreground shrink-0 ml-2">
                    {formatRelativeTime(pulse.scheduledAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs sm:text-sm text-muted-foreground text-center py-3 sm:py-4">
              {schedule.enabled ? 'No upcoming pulses' : 'Pulses disabled'}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

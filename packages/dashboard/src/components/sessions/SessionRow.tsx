import { useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Zap, CheckCircle, XCircle, Square, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeySourceBadge } from '@/components/ui/KeySourceBadge';
import { SessionTokenStats } from '@/components/ui/SessionTokenStats';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { stopSession } from '@/lib/api';
import type { Session } from '@/types/session';

interface SessionRowProps {
  session: Session;
  isExpanded: boolean;
  onToggle: () => void;
  onSessionStopped?: () => void;
}

const SOURCE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  slack: MessageSquare,
  api: Zap,
};

export function SessionRow({ session, isExpanded, onToggle, onSessionStopped }: SessionRowProps) {
  const [stopping, setStopping] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const SourceIcon = SOURCE_ICONS[session.source.toLowerCase()] || MessageSquare;
  
  const statusConfig = {
    starting: { color: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', label: 'Starting', pulse: true },
    running: { color: 'bg-blue-500/10 text-blue-400 border-blue-500/30', label: 'Running', pulse: true },
    completed: { color: 'bg-green-500/10 text-green-400 border-green-500/30', label: 'Completed', pulse: false },
    failed: { color: 'bg-red-500/10 text-red-400 border-red-500/30', label: 'Failed', pulse: false },
  };
  
  const config = statusConfig[session.status];
  const isRunning = session.status === 'starting' || session.status === 'running';
  
  const duration = session.completed_at && session.started_at
    ? ((session.completed_at - session.started_at) / 1000).toFixed(1) + 's'
    : null;
  
  const timestamp = formatDistanceToNow(new Date(session.created_at), { addSuffix: true });
  
  const promptPreview = session.user_prompt 
    ? session.user_prompt.slice(0, 80) + (session.user_prompt.length > 80 ? '…' : '')
    : '(no prompt)';

  const handleStopClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row toggle
    setShowStopConfirm(true);
  };

  const handleStopConfirm = async () => {
    if (stopping) return;
    
    setShowStopConfirm(false);
    setStopping(true);
    try {
      await stopSession(session.id);
      onSessionStopped?.();
    } catch (err) {
      console.error('Failed to stop session:', err);
      // Error is shown via UI state change (session will still show as running)
    } finally {
      setStopping(false);
    }
  };
  
  return (
    <div
      onClick={onToggle}
      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors border-b border-border/50 text-left cursor-pointer"
    >
      <div className="flex-shrink-0">
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      
      <div className="flex-shrink-0">
        <SourceIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline" className={`text-xs ${config.color} ${config.pulse ? 'animate-pulse' : ''}`}>
            {config.label}
          </Badge>
          <span className="text-xs text-muted-foreground">{timestamp}</span>
          {duration && (
            <span className="text-xs text-muted-foreground">• {duration}</span>
          )}
          {session.turn_count > 0 && (
            <span className="text-xs text-muted-foreground">• {session.turn_count} turns</span>
          )}
          {session.key_resolution && <KeySourceBadge keyResolution={session.key_resolution} />}
          <SessionTokenStats sessionId={session.id} />
        </div>
        <p className="text-sm text-foreground truncate">{promptPreview}</p>
      </div>
      
      <div className="flex-shrink-0 flex items-center gap-2">
        {isRunning && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleStopClick}
            disabled={stopping}
            className="h-7 px-2 text-red-400 hover:text-red-300 hover:bg-red-500/10"
            title="Stop this session"
          >
            {stopping ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
          </Button>
        )}
        {session.status === 'completed' && <CheckCircle className="h-4 w-4 text-green-400" />}
        {session.status === 'failed' && <XCircle className="h-4 w-4 text-red-400" />}
      </div>
      
      {/* Stop confirmation dialog - rendered outside the conditional to prevent unmount issues */}
      <AlertDialog open={showStopConfirm} onOpenChange={setShowStopConfirm}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will terminate the running agent container. The session cannot be resumed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleStopConfirm}
              className="bg-red-500 hover:bg-red-600"
            >
              Stop Session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

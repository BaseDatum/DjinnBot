import { useRef, useCallback, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  UserCheck,
  ArrowRight,
  Unlock,
  Lock,
  Play,
  CheckCircle2,
  XCircle,
  Activity,
  Trash2,
} from 'lucide-react';
import styles from './ProjectActivityFeed.module.css';

export interface ActivityEntry {
  id: string;
  type: string;
  timestamp: number;
  agentId?: string;
  agentEmoji?: string;
  taskTitle?: string;
  taskId?: string;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  runId?: string;
}

interface ProjectActivityFeedProps {
  entries: ActivityEntry[];
  onClear?: () => void;
}

function entryConfig(type: string): {
  Icon: React.ElementType;
  iconClass: string;
  label: (e: ActivityEntry) => React.ReactNode;
} {
  switch (type) {
    case 'TASK_CLAIMED':
      return {
        Icon: UserCheck,
        iconClass: styles.iconClaimed,
        label: (e) => (
          <>
            <span className={styles.agentChip}>{e.agentEmoji || '🤖'} {e.agentId}</span>
            {' claimed '}
            <span className={styles.taskLink}>{e.taskTitle || e.taskId}</span>
          </>
        ),
      };
    case 'TASK_STATUS_CHANGED':
      return {
        Icon: ArrowRight,
        iconClass: styles.iconTransitioned,
        label: (e) => (
          <>
            <span className={styles.taskLink}>{e.taskTitle || e.taskId}</span>
            {' moved '}
            <strong>{e.fromStatus}</strong> → <strong>{e.toStatus}</strong>
            {e.agentId && <> by <span className={styles.agentChip}>{e.agentEmoji || '🤖'} {e.agentId}</span></>}
          </>
        ),
      };
    case 'TASK_UNBLOCKED':
      return {
        Icon: Unlock,
        iconClass: styles.iconUnblocked,
        label: (e) => (
          <>
            <span className={styles.taskLink}>{e.taskTitle || e.taskId}</span>
            {' unblocked and ready'}
          </>
        ),
      };
    case 'TASK_BLOCKED':
      return {
        Icon: Lock,
        iconClass: styles.iconBlocked,
        label: (e) => (
          <>
            <span className={styles.taskLink}>{e.taskTitle || e.taskId}</span>
            {' blocked by upstream failure'}
          </>
        ),
      };
    case 'RUN_STARTED':
    case 'RUN_START':
      return {
        Icon: Play,
        iconClass: styles.iconRunStarted,
        label: (e) => (
          <>
            Run started for{' '}
            <span className={styles.taskLink}>{e.taskTitle || e.taskId || e.runId?.slice(0, 8)}</span>
          </>
        ),
      };
    case 'RUN_COMPLETED':
    case 'RUN_COMPLETE':
      return {
        Icon: CheckCircle2,
        iconClass: styles.iconRunCompleted,
        label: (e) => (
          <>
            Run completed
            {e.taskTitle && <> for <span className={styles.taskLink}>{e.taskTitle}</span></>}
          </>
        ),
      };
    case 'RUN_FAILED':
    case 'RUN_FAIL':
      return {
        Icon: XCircle,
        iconClass: styles.iconRunFailed,
        label: (e) => (
          <>
            Run failed
            {e.taskTitle && <> for <span className={styles.taskLink}>{e.taskTitle}</span></>}
          </>
        ),
      };
    default:
      return {
        Icon: Activity,
        iconClass: styles.iconSystem,
        label: (e) => <>{e.type.replace(/_/g, ' ').toLowerCase()}</>,
      };
  }
}

export function ProjectActivityFeed({ entries, onClear }: ProjectActivityFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Auto-scroll to bottom only when already at bottom
  const handleScroll = useCallback(() => {
    if (!feedRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    atBottomRef.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  useEffect(() => {
    if (atBottomRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className={styles.flyout}>
      {/* Collapsed tab — always visible */}
      <div className={styles.tab}>
        <span className={styles.liveDot} />
        <span className={styles.tabLabel}>Live Activity</span>
        {entries.length > 0 && (
          <span className={styles.badge}>{entries.length > 99 ? '99+' : entries.length}</span>
        )}
      </div>

      {/* Expanded panel — slides in on hover */}
      <div className={styles.panel}>
        <div className={styles.header}>
          <span className={styles.headerTitle}>
            <span className={styles.liveDot} />
            Live Activity
          </span>
          {entries.length > 0 && onClear && (
            <button className={styles.clearBtn} onClick={onClear}>
              <Trash2 className="inline h-3 w-3 mr-1" />
              Clear
            </button>
          )}
        </div>

        <div className={styles.feed} ref={feedRef} onScroll={handleScroll}>
          {entries.length === 0 ? (
            <div className={styles.empty}>
              <Activity className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
              Activity will appear here as agents work
            </div>
          ) : (
            entries.map((entry) => {
              const { Icon, iconClass, label } = entryConfig(entry.type);
              return (
                <div key={entry.id} className={styles.entry}>
                  <div className={`${styles.entryIcon} ${iconClass}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className={styles.entryBody}>
                    <div className={styles.entryText}>{label(entry)}</div>
                    <div className={styles.entryMeta}>
                      {formatDistanceToNow(entry.timestamp, { addSuffix: true })}
                      {entry.note && <> · {entry.note}</>}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

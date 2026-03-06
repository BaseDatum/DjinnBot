import { AgentState, WorkInfo } from '@/types/lifecycle';
import { STATE_CONFIG, SIZE_CONFIG } from '@/lib/constants';
import { cn } from '@/lib/utils';

interface AgentStateBadgeProps {
  state: AgentState;
  currentWork?: WorkInfo;
  size?: 'sm' | 'md' | 'lg';
  showWork?: boolean;
  className?: string;
}

export function AgentStateBadge({
  state,
  currentWork,
  size = 'md',
  showWork = true,
  className,
}: AgentStateBadgeProps) {
  const config = STATE_CONFIG[state];
  const sizeConfig = SIZE_CONFIG[size];

  return (
    <div
      role="status"
      aria-label={`Agent state: ${config.label}${currentWork ? ` working on ${currentWork.stepType}` : ''}`}
      className={cn(
        'inline-flex items-center rounded-md bg-zinc-900 border border-zinc-800',
        sizeConfig.padding,
        sizeConfig.gap,
        className
      )}
    >
      {/* Animated dot */}
      <div className="relative flex-shrink-0">
        <div className={cn('rounded-full', config.color, sizeConfig.dot)} />
        {state === 'working' && (
          <div
            className={cn(
              'absolute inset-0 rounded-full animate-ping',
              config.color,
              'opacity-75',
              sizeConfig.dot
            )}
          />
        )}
      </div>

      {/* State label */}
      <span className={cn('font-medium', config.textColor, sizeConfig.text)}>
        {config.label}
      </span>

      {/* Current work (optional) */}
      {showWork && currentWork && state === 'working' && (
        <>
          <span className="text-zinc-600">→</span>
          <span className={cn('text-zinc-400', sizeConfig.text)}>
            {currentWork.stepType}
          </span>
        </>
      )}
    </div>
  );
}

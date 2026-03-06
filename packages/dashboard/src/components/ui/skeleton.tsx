import SkeletonBase, { SkeletonTheme } from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';

export { SkeletonTheme };

/**
 * Thin wrapper around react-loading-skeleton's Skeleton component.
 * Use this directly for custom shapes, or use the pre-built helpers below.
 */
export function Skeleton(props: React.ComponentProps<typeof SkeletonBase>) {
  return <SkeletonBase {...props} />;
}

/** A single text line skeleton */
export function SkeletonLine({ width = '100%' }: { width?: string | number }) {
  return <Skeleton width={width} height={16} />;
}

/** A circular avatar/icon skeleton */
export function SkeletonCircle({ size = 40 }: { size?: number }) {
  return <Skeleton circle width={size} height={size} />;
}

/** A rounded rectangle block — good for cards, buttons, images */
export function SkeletonBlock({
  height = 40,
  width = '100%',
  className,
}: {
  height?: number | string;
  width?: number | string;
  className?: string;
}) {
  return (
    <span className={className}>
      <Skeleton height={height} width={width} />
    </span>
  );
}

/** A full card-shaped skeleton placeholder */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <SkeletonCircle size={36} />
        <div className="flex-1 space-y-1.5">
          <Skeleton width="50%" height={14} />
          <Skeleton width="30%" height={12} />
        </div>
      </div>
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            height={13}
            width={i === lines - 1 ? '70%' : '100%'}
          />
        ))}
      </div>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot } from 'lucide-react';
import { API_BASE } from '@/lib/api';

/**
 * Full-page animated overlay shown while DjinnBot is updating itself.
 *
 * Covers the entire viewport with a dark backdrop, displays an animated
 * DjinnBot logo with orbiting particles, rotating status messages, and
 * a progress bar. Polls the API health endpoint and auto-reloads the
 * page once the new version is up.
 */

const STATUS_MESSAGES = [
  'Pulling new container images...',
  'Summoning the latest djinn...',
  'Upgrading neural pathways...',
  'Polishing the genie lamp...',
  'Reticulating splines...',
  'Teaching old bots new tricks...',
  'Warming up the new engines...',
  'Aligning quantum flux capacitors...',
  'Almost there...',
];

interface UpdateOverlayProps {
  targetVersion: string;
  onDismiss?: () => void;
}

export function UpdateOverlay({ targetVersion, onDismiss }: UpdateOverlayProps) {
  const [messageIndex, setMessageIndex] = useState(0);
  const [dots, setDots] = useState('');
  const [healthCheckActive, setHealthCheckActive] = useState(false);
  const [apiReturned, setApiReturned] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cycle through status messages
  useEffect(() => {
    const interval = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % STATUS_MESSAGES.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  // Animate dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Elapsed time counter
  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Start health checking after a brief delay (give containers time to stop)
  useEffect(() => {
    const timer = setTimeout(() => {
      setHealthCheckActive(true);
    }, 8000); // Wait 8s before polling
    return () => clearTimeout(timer);
  }, []);

  // Poll /v1/status until the API comes back
  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        setApiReturned(true);
      }
    } catch {
      // API still down — keep polling
    }
  }, []);

  useEffect(() => {
    if (!healthCheckActive || apiReturned) return;
    healthIntervalRef.current = setInterval(checkHealth, 3000);
    return () => {
      if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
    };
  }, [healthCheckActive, apiReturned, checkHealth]);

  // Auto-reload once the API returns
  useEffect(() => {
    if (apiReturned) {
      // Small delay so the user sees the "we're back" state
      const timer = setTimeout(() => {
        window.location.reload();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [apiReturned]);

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/98 backdrop-blur-sm">
      {/* Animated background particles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-primary/10"
            style={{
              width: `${4 + Math.random() * 8}px`,
              height: `${4 + Math.random() * 8}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animation: `updateFloat ${6 + Math.random() * 8}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 5}s`,
            }}
          />
        ))}
      </div>

      {/* Center content */}
      <div className="relative flex flex-col items-center gap-8 px-6 text-center">
        {/* Animated logo */}
        <div className="relative">
          {/* Outer ring */}
          <div
            className="absolute inset-0 rounded-full border-2 border-primary/20"
            style={{
              width: '120px',
              height: '120px',
              margin: '-20px',
              animation: 'updateSpin 8s linear infinite',
            }}
          />
          {/* Inner ring (counter-rotate) */}
          <div
            className="absolute inset-0 rounded-full border-2 border-dashed border-primary/30"
            style={{
              width: '100px',
              height: '100px',
              margin: '-10px',
              animation: 'updateSpin 6s linear infinite reverse',
            }}
          />
          {/* Bot icon with pulse */}
          <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-primary shadow-lg shadow-primary/25">
            <Bot
              className="h-10 w-10 text-primary-foreground"
              style={{ animation: 'updatePulse 2s ease-in-out infinite' }}
            />
          </div>

          {/* Orbiting dot */}
          <div
            className="absolute h-3 w-3 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50"
            style={{
              animation: 'updateOrbit 3s linear infinite',
              top: '50%',
              left: '50%',
            }}
          />
        </div>

        {/* Title */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            DjinnBot is updating DjinnBot
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upgrading to <span className="font-mono font-semibold text-primary">{targetVersion}</span>
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-72">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{
                animation: 'updateProgress 3s ease-in-out infinite',
              }}
            />
          </div>
        </div>

        {/* Rotating status message */}
        <p className="h-6 text-sm text-muted-foreground transition-opacity duration-500">
          {apiReturned ? (
            <span className="text-emerald-500 font-medium">
              Update complete — reloading...
            </span>
          ) : (
            <>
              {STATUS_MESSAGES[messageIndex]}
              <span className="inline-block w-6 text-left">{dots}</span>
            </>
          )}
        </p>

        {/* Elapsed time */}
        <p className="text-xs text-muted-foreground/50">
          {secondsElapsed}s elapsed
        </p>
      </div>

      {/* Inline styles for animations (avoids needing tailwind config changes) */}
      <style>{`
        @keyframes updateFloat {
          0%, 100% { transform: translateY(0) scale(1); opacity: 0.3; }
          50% { transform: translateY(-30px) scale(1.5); opacity: 0.6; }
        }
        @keyframes updateSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes updatePulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        @keyframes updateOrbit {
          from {
            transform: rotate(0deg) translateX(52px) rotate(0deg);
          }
          to {
            transform: rotate(360deg) translateX(52px) rotate(-360deg);
          }
        }
        @keyframes updateProgress {
          0% { width: 0%; margin-left: 0%; }
          50% { width: 60%; margin-left: 20%; }
          100% { width: 0%; margin-left: 100%; }
        }
      `}</style>
    </div>
  );
}

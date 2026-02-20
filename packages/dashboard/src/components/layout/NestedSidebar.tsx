import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Menu, X } from 'lucide-react';

export interface NestedSidebarItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Optional badge count displayed on the item */
  badge?: number;
  /** If set, renders as an external link rather than a tab selector */
  href?: string;
  /** If set, renders as a button that calls this handler instead of selecting a tab */
  onClick?: () => void;
}

interface NestedSidebarProps {
  items: NestedSidebarItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  children: React.ReactNode;
}

/**
 * NestedSidebar — a secondary navigation sidebar designed to be embedded inside
 * a page that previously used horizontal tabs.
 *
 * Desktop: icon-only rail (w-12) that expands to show labels on hover OR when
 * pinned open by clicking. Uses CSS group-hover for a smooth transition so no
 * JS re-render is needed for the expand animation.
 *
 * Mobile: collapsed into a bottom drawer triggered by a floating button.
 */
export function NestedSidebar({ items, activeKey, onSelect, children }: NestedSidebarProps) {
  const [pinned, setPinned] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  // Close mobile drawer on outside click
  useEffect(() => {
    if (!mobileOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
        setMobileOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mobileOpen]);

  const handleSelect = (key: string) => {
    onSelect(key);
    setMobileOpen(false);
  };

  const NavItems = ({ showLabels }: { showLabels: boolean }) => (
    <ul className="flex flex-col gap-0.5 p-2">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.key === activeKey;

        if (item.href) {
          return (
            <li key={item.key}>
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
                  'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  showLabels ? 'min-w-0' : 'justify-center'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {showLabels && (
                  <span className="truncate">{item.label}</span>
                )}
              </a>
            </li>
          );
        }

        if (item.onClick) {
          return (
            <li key={item.key}>
              <button
                onClick={() => { item.onClick!(); setMobileOpen(false); }}
                title={!showLabels ? item.label : undefined}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
                  'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  showLabels ? 'min-w-0' : 'justify-center'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {showLabels && (
                  <span className="truncate">{item.label}</span>
                )}
              </button>
            </li>
          );
        }

        return (
          <li key={item.key}>
            <button
              onClick={() => handleSelect(item.key)}
              title={!showLabels ? item.label : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                showLabels ? 'min-w-0' : 'justify-center'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {showLabels && (
                <>
                  <span className="truncate flex-1 text-left">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span
                      className={cn(
                        'ml-auto text-xs px-1.5 py-0.5 rounded-full shrink-0',
                        isActive
                          ? 'bg-primary-foreground/20 text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </>
              )}
              {!showLabels && item.badge !== undefined && item.badge > 0 && (
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-destructive" />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* ── Desktop sidebar ── */}
      <aside
        className={cn(
          'hidden md:flex flex-col border-r bg-card shrink-0 overflow-hidden',
          'transition-[width] duration-200 ease-in-out',
          // When pinned, stay wide; otherwise use group-hover on the element itself
          pinned ? 'w-52' : 'w-12 hover:w-52 group'
        )}
        aria-label="Section navigation"
      >
        {/* Pin toggle */}
        <div className="flex items-center justify-end px-1 pt-2 pb-1 border-b">
          <button
            onClick={() => setPinned((p) => !p)}
            title={pinned ? 'Collapse sidebar' : 'Pin sidebar open'}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            {pinned ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <Menu className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden">
          {/* Icon-only rail (visible when collapsed and not hovering) */}
          {!pinned && (
            <div className="group-hover:hidden">
              <NavItems showLabels={false} />
            </div>
          )}
          {/* Labeled list (visible when hovering or pinned) */}
          <div className={cn(!pinned && 'hidden group-hover:block')}>
            <NavItems showLabels={true} />
          </div>
        </nav>
      </aside>

      {/* ── Mobile: floating trigger + bottom drawer ── */}
      <div className="md:hidden">
        {/* Trigger button — fixed bottom-left so it doesn't scroll away */}
        <button
          onClick={() => setMobileOpen(true)}
          className="fixed bottom-4 left-4 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg"
          aria-label="Open section navigation"
        >
          <Menu className="h-4 w-4" />
          {items.find((i) => i.key === activeKey)?.label ?? 'Navigate'}
        </button>

        {/* Overlay */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}

        {/* Bottom drawer */}
        <aside
          ref={sidebarRef}
          className={cn(
            'fixed bottom-0 left-0 right-0 z-50 rounded-t-xl bg-card border-t shadow-xl',
            'transition-transform duration-300 ease-in-out',
            mobileOpen ? 'translate-y-0' : 'translate-y-full'
          )}
          aria-label="Section navigation"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <span className="text-sm font-semibold">Navigate</span>
            <button
              onClick={() => setMobileOpen(false)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Scrollable grid of items */}
          <nav className="max-h-72 overflow-y-auto">
            <NavItems showLabels={true} />
          </nav>
        </aside>
      </div>

      {/* ── Main content area ── */}
      <div className="flex-1 overflow-auto p-4 md:p-8">
        {children}
      </div>
    </div>
  );
}

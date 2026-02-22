/**
 * SearchableCombobox — generic popover with fuzzy search and keyboard navigation.
 *
 * Used for:
 *   - Provider selection (admin key sharing)
 *   - User selection by email (admin key sharing, project key user)
 */
import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChevronDown, Search, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary text shown below the label (e.g. email, description) */
  sublabel?: string;
}

interface SearchableComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Allow typing a custom value not in the list */
  allowCustom?: boolean;
  className?: string;
  disabled?: boolean;
}

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  // Simple substring match — good enough for small lists
  return lower.includes(q);
}

export function SearchableCombobox({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  allowCustom = false,
  className,
  disabled = false,
}: SearchableComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    return options.filter(
      (o) =>
        fuzzyMatch(o.label, search) ||
        (o.sublabel && fuzzyMatch(o.sublabel, search)),
    );
  }, [options, search]);

  // Reset highlight when search changes
  useEffect(() => setHighlightIdx(0), [search]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setSearch('');
    }
  }, [open]);

  const selectedOption = options.find((o) => o.value === value);

  const handleSelect = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIdx]) {
        handleSelect(filtered[highlightIdx].value);
      } else if (allowCustom && search.trim()) {
        handleSelect(search.trim());
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            'flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm',
            'bg-background hover:bg-accent/50 transition-colors w-full text-left min-h-[36px]',
            disabled && 'opacity-50 cursor-not-allowed',
            className,
          )}
        >
          <span className={cn('truncate', !selectedOption && 'text-muted-foreground')}>
            {selectedOption ? selectedOption.label : value || placeholder}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        sideOffset={4}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={searchPlaceholder}
            className="h-8 border-0 p-0 shadow-none focus-visible:ring-0 text-sm"
          />
        </div>
        <ScrollArea className="max-h-[240px]">
          <div className="p-1">
            {filtered.length === 0 && !allowCustom && (
              <p className="text-sm text-muted-foreground px-3 py-4 text-center">
                No matches found.
              </p>
            )}
            {filtered.map((option, idx) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleSelect(option.value)}
                className={cn(
                  'flex items-center gap-2 w-full rounded-sm px-3 py-2 text-sm text-left transition-colors',
                  idx === highlightIdx && 'bg-accent',
                  option.value === value && 'font-medium',
                )}
                onMouseEnter={() => setHighlightIdx(idx)}
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate">{option.label}</div>
                  {option.sublabel && (
                    <div className="truncate text-xs text-muted-foreground">{option.sublabel}</div>
                  )}
                </div>
                {option.value === value && (
                  <Check className="h-4 w-4 text-primary shrink-0" />
                )}
              </button>
            ))}
            {allowCustom && search.trim() && !filtered.find((o) => o.value === search.trim()) && (
              <button
                type="button"
                onClick={() => handleSelect(search.trim())}
                className="flex items-center gap-2 w-full rounded-sm px-3 py-2 text-sm text-left text-primary hover:bg-accent"
              >
                Use "{search.trim()}"
              </button>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

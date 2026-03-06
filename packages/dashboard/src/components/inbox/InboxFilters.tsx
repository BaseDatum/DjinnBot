import { InboxFilter } from '@/types/inbox';
import { Button } from '@/components/ui/button';

interface InboxFiltersProps {
  filter: InboxFilter;
  onFilterChange: (filter: InboxFilter) => void;
}

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'review_request', label: 'Review Requests' },
  { value: 'help_request', label: 'Help Requests' },
];

export function InboxFilters({ filter, onFilterChange }: InboxFiltersProps) {
  return (
    <div className="p-3 border-b bg-muted/10 flex items-center gap-2 overflow-x-auto">
      {FILTERS.map((f) => (
        <Button
          key={f.value}
          size="sm"
          variant={filter === f.value ? 'default' : 'outline'}
          onClick={() => onFilterChange(f.value)}
        >
          {f.label}
        </Button>
      ))}
    </div>
  );
}

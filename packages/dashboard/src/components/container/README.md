# Container Event Components

This directory contains components for displaying container events from the Redis protocol.

## Components

### ContainerStatus.tsx
Visual indicators for container lifecycle state.

**ContainerStatusBadge**
```tsx
<ContainerStatusBadge status="busy" runId="abc123" />
```
Shows a badge with appropriate icon and color for the container state.

**ContainerStatusCard**
```tsx
<ContainerStatusCard 
  status="ready" 
  runId="abc123"
  lastUpdate={Date.now()}
/>
```
Card displaying current container status with timestamp.

### ContainerEventStream.tsx
Real-time event stream display with expandable details.

**ContainerEventStream**
```tsx
<ContainerEventStream 
  events={containerEvents}
  maxHeight="400px"
/>
```
Main event stream component with:
- Scrollable event list
- Category-based grouping
- Expandable event details
- Event statistics
- Empty state handling

**ContainerEventSummary**
```tsx
<ContainerEventSummary events={containerEvents} />
```
Compact version showing recent events (useful for sidebars).

## Event Categories

- **status**: Container lifecycle (ready, busy, idle, error, exiting)
- **step**: Step execution (start, end)
- **tool**: Tool calls (start, end with duration)
- **output**: stdout/stderr streams
- **message**: Agent messaging events (agentMessage, slackDm)

## Styling

All components use Tailwind CSS and follow the dashboard's design system:
- Badge variants for status indicators
- Card components for containers
- Scroll areas for long lists
- Responsive sizing
- Color-coded severity (success/error/warning/info)

## Usage Example

See `packages/dashboard/src/routes/runs/$runId.tsx` for a complete integration example.

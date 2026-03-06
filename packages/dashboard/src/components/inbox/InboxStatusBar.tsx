interface InboxStatusBarProps {
  messageCount: number;
  totalCount: number;
}

export function InboxStatusBar({ messageCount, totalCount }: InboxStatusBarProps) {
  return (
    <div className="p-2 border-t text-xs text-muted-foreground flex items-center gap-2 bg-muted/20">
      <span>{messageCount} messages</span>
      {messageCount !== totalCount && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground/50">({totalCount} total)</span>
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Button } from '@/components/ui/button';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Trash2, Inbox, ListRestart, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { 
  resetAgentSandbox, 
  clearAgentInbox, 
  clearAgentQueue 
} from '@/lib/api';

interface DangerZoneProps {
  agentId: string;
  agentName: string;
  onActionComplete?: () => void;
}

type ActionType = 'sandbox' | 'inbox' | 'queue' | null;

export function DangerZone({ agentId, agentName, onActionComplete }: DangerZoneProps) {
  const [activeAction, setActiveAction] = useState<ActionType>(null);
  const [executing, setExecuting] = useState(false);

  const actions = {
    sandbox: {
      title: 'Reset Sandbox',
      description: 'Wipe /usr/local and /home/agent directories',
      icon: Trash2,
      color: 'destructive' as const,
      confirmTitle: 'Reset Sandbox Environment?',
      confirmDescription: (
        <>
          This will <strong>permanently delete</strong> all files in:
          <ul className="list-disc list-inside mt-2 space-y-1">
            <li><code className="text-xs">/usr/local</code> — Installed packages and libraries</li>
            <li><code className="text-xs">/home/agent</code> — Agent's home directory</li>
          </ul>
          <p className="mt-3 text-destructive font-semibold">
            This action cannot be undone. The agent will need to reinstall all dependencies.
          </p>
        </>
      ),
      confirmButtonText: 'Reset Sandbox',
      execute: async () => resetAgentSandbox(agentId),
      successMessage: 'Sandbox environment reset successfully',
    },
    inbox: {
      title: 'Clear Inbox',
      description: 'Delete all messages',
      icon: Inbox,
      color: 'outline' as const,
      confirmTitle: 'Clear All Messages?',
      confirmDescription: (
        <>
          This will <strong>permanently delete</strong> all messages in {agentName}'s inbox.
          <p className="mt-3">
            Unread messages, help requests, and review requests will be lost.
          </p>
          <p className="mt-2 text-muted-foreground">
            Consider exporting important messages before clearing.
          </p>
        </>
      ),
      confirmButtonText: 'Clear Inbox',
      execute: async () => clearAgentInbox(agentId),
      successMessage: 'Inbox cleared successfully',
    },
    queue: {
      title: 'Clear Queue',
      description: 'Drop all queued work items',
      icon: ListRestart,
      color: 'outline' as const,
      confirmTitle: 'Clear Work Queue?',
      confirmDescription: (
        <>
          This will <strong>drop all queued work items</strong> for {agentName}.
          <p className="mt-3">
            Pending reviews, implementations, and other tasks will be lost.
          </p>
          <p className="mt-2 text-muted-foreground">
            This does not stop currently executing work.
          </p>
        </>
      ),
      confirmButtonText: 'Clear Queue',
      execute: async () => clearAgentQueue(agentId),
      successMessage: 'Work queue cleared successfully',
    },
  };

  const handleAction = async (type: ActionType) => {
    if (!type) return;

    setExecuting(true);
    try {
      await actions[type].execute();
      toast.success(actions[type].successMessage);
      setActiveAction(null);
      onActionComplete?.();
    } catch (error) {
      console.error(`Failed to execute ${type} action:`, error);
      toast.error(
        error instanceof Error 
          ? error.message 
          : `Failed to ${actions[type].title.toLowerCase()}`
      );
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Danger Zone Header */}
      <Alert variant="destructive" className="border-2">
        <AlertTriangle className="h-5 w-5" />
        <AlertDescription className="text-base font-semibold">
          Danger Zone
        </AlertDescription>
      </Alert>

      {/* Warning Text */}
      <p className="text-sm text-muted-foreground">
        These actions are permanent and cannot be undone. Use with caution.
      </p>

      {/* Action Buttons */}
      <div className="space-y-3 border-2 border-destructive/50 rounded-lg p-4 bg-destructive/5">
        {(Object.keys(actions) as ActionType[]).map((type) => {
          if (!type) return null;
          const action = actions[type];
          const Icon = action.icon;

          return (
            <div
              key={type}
              className="flex items-center justify-between p-3 border rounded-lg bg-background"
            >
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">{action.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {action.description}
                  </p>
                </div>
              </div>
              <Button
                variant={action.color}
                size="sm"
                onClick={() => setActiveAction(type)}
                disabled={executing}
              >
                {action.title}
              </Button>
            </div>
          );
        })}
      </div>

      {/* Confirmation Dialogs */}
      {(Object.keys(actions) as ActionType[]).map((type) => {
        if (!type) return null;
        const action = actions[type];

        return (
          <AlertDialog
            key={type}
            open={activeAction === type}
            onOpenChange={(open) => !open && setActiveAction(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  {action.confirmTitle}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-left">
                  {action.confirmDescription}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={executing}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => handleAction(type)}
                  disabled={executing}
                  className="bg-destructive hover:bg-destructive/90"
                >
                  {executing ? 'Processing...' : action.confirmButtonText}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      })}
    </div>
  );
}

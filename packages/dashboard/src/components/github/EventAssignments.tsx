import { useState, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Edit, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface EventAssignment {
  id: string;
  projectId: string;
  eventType: string;
  eventAction?: string;
  agentId: string;
  agentName: string;
  filters: Record<string, any>;
  autoRespond: boolean;
  createdAt: string;
}

interface Agent {
  id: string;
  name: string;
}

interface EventAssignmentsProps {
  projectId: string;
}

const EVENT_TYPES = [
  { value: 'issues', label: 'Issues', actions: ['opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled'] },
  { value: 'pull_request', label: 'Pull Requests', actions: ['opened', 'edited', 'closed', 'reopened', 'synchronize', 'review_requested'] },
  { value: 'issue_comment', label: 'Issue Comments', actions: ['created', 'edited', 'deleted'] },
  { value: 'pull_request_review', label: 'PR Reviews', actions: ['submitted', 'edited', 'dismissed'] },
  { value: 'push', label: 'Push', actions: [] },
  { value: 'release', label: 'Release', actions: ['published', 'created', 'edited'] },
];

export function EventAssignments({ projectId }: EventAssignmentsProps) {
  const [assignments, setAssignments] = useState<EventAssignment[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<EventAssignment | null>(null);

  // Modal form state
  const [eventType, setEventType] = useState('');
  const [eventAction, setEventAction] = useState('');
  const [agentId, setAgentId] = useState('');
  const [autoRespond, setAutoRespond] = useState(true);
  const [filtersJson, setFiltersJson] = useState('{}');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchAssignments();
    fetchAgents();
  }, [projectId]);

  async function fetchAssignments() {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/projects/${projectId}/github/assignments`);
      if (!response.ok) throw new Error('Failed to fetch assignments');
      const data = await response.json();
      setAssignments(data);
    } catch (error) {
      console.error('Failed to fetch assignments:', error);
      toast.error('Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }

  async function fetchAgents() {
    try {
      const response = await fetch(`${API_BASE}/projects/${projectId}/agents`);
      if (!response.ok) throw new Error('Failed to fetch agents');
      const data = await response.json();
      setAgents(data);
    } catch (error) {
      console.error('Failed to fetch agents:', error);
      toast.error('Failed to load agents');
    }
  }

  async function handleDelete(assignmentId: string) {
    if (!confirm('Delete this assignment?')) return;

    try {
      const response = await fetch(`${API_BASE}/projects/${projectId}/github/assignments/${assignmentId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to delete assignment');
      
      setAssignments(assignments.filter((a) => a.id !== assignmentId));
      toast.success('Assignment deleted');
    } catch (error) {
      console.error('Failed to delete assignment:', error);
      toast.error('Failed to delete assignment');
    }
  }

  async function toggleAutoRespond(assignment: EventAssignment) {
    try {
      const response = await fetch(`${API_BASE}/projects/${projectId}/github/assignments/${assignment.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRespond: !assignment.autoRespond }),
      });
      if (!response.ok) throw new Error('Failed to update assignment');
      
      // Update local state
      setAssignments(assignments.map(a => 
        a.id === assignment.id ? { ...a, autoRespond: !a.autoRespond } : a
      ));
      toast.success('Auto-respond updated');
    } catch (error) {
      console.error('Failed to toggle auto-respond:', error);
      toast.error('Failed to update auto-respond');
    }
  }

  function handleEdit(assignment: EventAssignment) {
    setEditingAssignment(assignment);
    setEventType(assignment.eventType);
    setEventAction(assignment.eventAction || '');
    setAgentId(assignment.agentId);
    setAutoRespond(assignment.autoRespond);
    setFiltersJson(JSON.stringify(assignment.filters, null, 2));
    setModalOpen(true);
  }

  function handleCreate() {
    setEditingAssignment(null);
    setEventType('');
    setEventAction('');
    setAgentId('');
    setAutoRespond(true);
    setFiltersJson('{}');
    setModalOpen(true);
  }

  function handleModalClose() {
    setModalOpen(false);
    setEditingAssignment(null);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Validate filters JSON
      let filters: Record<string, any> = {};
      try {
        filters = JSON.parse(filtersJson);
      } catch {
        toast.error('Invalid filters JSON');
        setSaving(false);
        return;
      }

      const payload = {
        eventType,
        eventAction: eventAction || null,
        agentId,
        filters,
        autoRespond,
      };

      const url = editingAssignment
        ? `${API_BASE}/projects/${projectId}/github/assignments/${editingAssignment.id}`
        : `${API_BASE}/projects/${projectId}/github/assignments`;

      const response = await fetch(url, {
        method: editingAssignment ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to save assignment');
      }

      toast.success(editingAssignment ? 'Assignment updated' : 'Assignment created');
      handleModalClose();
      fetchAssignments();
    } catch (error) {
      console.error('Failed to save assignment:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save assignment');
    } finally {
      setSaving(false);
    }
  }

  const selectedEventType = EVENT_TYPES.find((et) => et.value === eventType);
  const isFormValid = eventType && agentId;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Event Assignments</CardTitle>
            <Button onClick={handleCreate} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Assignment
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : assignments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No assignments configured. Add one to get started.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event Type</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Filters</TableHead>
                  <TableHead>Auto-Respond</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments.map((assignment) => (
                  <TableRow key={assignment.id}>
                    <TableCell>
                      <div className="font-medium">{assignment.eventType}</div>
                      {assignment.eventAction && (
                        <div className="text-sm text-muted-foreground">{assignment.eventAction}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{assignment.agentName}</Badge>
                    </TableCell>
                    <TableCell>
                      {Object.keys(assignment.filters).length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(assignment.filters).slice(0, 3).map(([key, value]) => (
                            <Badge key={key} variant="outline" className="text-xs">
                              {key}: {JSON.stringify(value)}
                            </Badge>
                          ))}
                          {Object.keys(assignment.filters).length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{Object.keys(assignment.filters).length - 3}
                            </Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">No filters</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={assignment.autoRespond}
                        onCheckedChange={() => toggleAutoRespond(assignment)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(assignment)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(assignment.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Assignment Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingAssignment ? 'Edit Assignment' : 'Create Assignment'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label htmlFor="eventType">Event Type</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger id="eventType">
                  <SelectValue placeholder="Select event type" />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedEventType && selectedEventType.actions.length > 0 && (
              <div>
                <Label htmlFor="eventAction">Event Action (optional)</Label>
                <Select value={eventAction} onValueChange={setEventAction}>
                  <SelectTrigger id="eventAction">
                    <SelectValue placeholder="All actions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All actions</SelectItem>
                    {selectedEventType.actions.map((action) => (
                      <SelectItem key={action} value={action}>
                        {action}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div>
              <Label htmlFor="agent">Agent</Label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="agent">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="filters">Filters (JSON)</Label>
              <Input
                id="filters"
                placeholder='{"labels": ["bug"], "author": "username"}'
                value={filtersJson}
                onChange={(e) => setFiltersJson(e.target.value)}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Optional: Filter events by labels, authors, etc.
              </p>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="autoRespond"
                checked={autoRespond}
                onCheckedChange={setAutoRespond}
              />
              <Label htmlFor="autoRespond">Auto-respond (no confirmation)</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleModalClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !isFormValid}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Assignment'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

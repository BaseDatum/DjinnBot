import { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Cookie, Plus, Trash2, Upload, Loader2, Shield, ShieldCheck,
  Globe, Clock, Users, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchBrowserCookieSets,
  uploadBrowserCookieSet,
  deleteBrowserCookieSet,
  fetchAgentCookieGrants,
  grantCookiesToAgent,
  revokeCookiesFromAgent,
  fetchAgents,
  type BrowserCookieSetItem,
  type BrowserCookieGrantItem,
  type AgentListItem,
} from '@/lib/api';

export function BrowserCookiesPage() {
  const [cookieSets, setCookieSets] = useState<BrowserCookieSetItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [agentGrants, setAgentGrants] = useState<BrowserCookieGrantItem[]>([]);
  const [grantLoading, setGrantLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sets, agentList] = await Promise.all([
        fetchBrowserCookieSets(),
        fetchAgents(),
      ]);
      setCookieSets(sets);
      setAgents(agentList);
    } catch (err) {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Load grants when agent selected
  useEffect(() => {
    if (!selectedAgent) { setAgentGrants([]); return; }
    setGrantLoading(true);
    fetchAgentCookieGrants(selectedAgent)
      .then(setAgentGrants)
      .catch(() => toast.error('Failed to load grants'))
      .finally(() => setGrantLoading(false));
  }, [selectedAgent]);

  const handleUpload = async () => {
    if (!uploadName.trim() || !uploadFile) {
      toast.error('Name and cookie file required');
      return;
    }
    setUploading(true);
    try {
      await uploadBrowserCookieSet(uploadName.trim(), uploadFile);
      toast.success('Cookie set uploaded');
      setShowUpload(false);
      setUploadName('');
      setUploadFile(null);
      await loadData();
    } catch (err) {
      toast.error('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBrowserCookieSet(id);
      toast.success('Cookie set deleted');
      await loadData();
      if (selectedAgent) {
        const g = await fetchAgentCookieGrants(selectedAgent);
        setAgentGrants(g);
      }
    } catch (err) {
      toast.error('Delete failed');
    }
  };

  const isGranted = (cookieSetId: string) =>
    agentGrants.some(g => g.cookie_set_id === cookieSetId);

  const handleToggleGrant = async (cookieSetId: string) => {
    if (!selectedAgent) return;
    try {
      if (isGranted(cookieSetId)) {
        await revokeCookiesFromAgent(selectedAgent, cookieSetId);
        toast.success('Access revoked');
      } else {
        await grantCookiesToAgent(selectedAgent, cookieSetId);
        toast.success('Access granted');
      }
      const g = await fetchAgentCookieGrants(selectedAgent);
      setAgentGrants(g);
    } catch (err) {
      toast.error('Failed to update access');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Cookie className="h-6 w-6" /> Browser Cookies
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage browser cookies for authenticated agent browsing via Camofox
          </p>
        </div>
        <Button onClick={() => setShowUpload(!showUpload)} size="sm">
          <Plus className="h-4 w-4 mr-1" /> Upload Cookies
        </Button>
      </div>

      {/* Upload form */}
      {showUpload && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="h-4 w-4" /> Upload Cookie File
            </CardTitle>
            <CardDescription>
              Upload a Netscape-format cookies.txt file exported from your browser
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cookie-name">Name</Label>
              <Input
                id="cookie-name"
                placeholder="e.g., LinkedIn, GitHub"
                value={uploadName}
                onChange={e => setUploadName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cookie-file">Cookie File (.txt)</Label>
              <Input
                id="cookie-file"
                type="file"
                accept=".txt,.cookie,.cookies"
                onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleUpload} disabled={uploading} size="sm">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
                Upload
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowUpload(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cookie sets list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cookie Sets</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : cookieSets.length === 0 ? (
            <p className="text-muted-foreground py-4 text-sm">
              No cookie sets uploaded yet. Upload a Netscape-format cookies.txt file to get started.
            </p>
          ) : (
            <div className="divide-y">
              {cookieSets.map(cs => (
                <div key={cs.id} className="py-3 flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{cs.name}</span>
                      <Badge variant="outline" className="text-xs flex items-center gap-1">
                        <Globe className="h-3 w-3" /> {cs.domain}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {cs.cookie_count} cookies
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(cs.created_at).toLocaleDateString()}
                      </span>
                      {cs.updated_at !== cs.created_at && (
                        <span className="flex items-center gap-1">
                          <RefreshCw className="h-3 w-3" />
                          Synced: {new Date(cs.updated_at).toLocaleString()}
                        </span>
                      )}
                      {cs.expires_at && (
                        <span>
                          Expires: {new Date(cs.expires_at * 1000).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleDelete(cs.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Agent permissions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" /> Agent Permissions
          </CardTitle>
          <CardDescription>
            Select an agent to manage which cookie sets they can access
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Agent</Label>
            <select
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedAgent}
              onChange={e => setSelectedAgent(e.target.value)}
            >
              <option value="">Select an agent...</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.id}</option>
              ))}
            </select>
          </div>

          {selectedAgent && (
            grantLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading grants...
              </div>
            ) : cookieSets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No cookie sets available to grant.</p>
            ) : (
              <div className="divide-y">
                {cookieSets.map(cs => {
                  const granted = isGranted(cs.id);
                  return (
                    <div key={cs.id} className="py-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {granted ? (
                          <ShieldCheck className="h-4 w-4 text-green-500" />
                        ) : (
                          <Shield className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-sm font-medium">{cs.name}</span>
                        <Badge variant="outline" className="text-xs">{cs.domain}</Badge>
                      </div>
                      <Button
                        variant={granted ? 'destructive' : 'default'}
                        size="sm"
                        onClick={() => handleToggleGrant(cs.id)}
                      >
                        {granted ? 'Revoke' : 'Grant'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}

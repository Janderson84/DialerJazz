import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, UserPlus, Phone, PhoneCall, Clock, Target, Trash2,
  Loader2, AlertCircle, CheckCircle2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { teamApi, type TeamMember } from '@/lib/team';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function TeamPage() {
  const navigate = useNavigate();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [invitePassword, setInvitePassword] = useState('');
  const [isInviting, setIsInviting] = useState(false);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await teamApi.list();
      setMembers(res.data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to load team');
    } finally {
      setIsLoading(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || !invitePassword.trim()) {
      toast.error('Email and password are required');
      return;
    }
    setIsInviting(true);
    try {
      await teamApi.invite(inviteEmail.trim(), invitePassword, inviteName.trim() || undefined);
      toast.success(`Account created for ${inviteEmail.trim()}`);
      setInviteEmail(''); setInviteName(''); setInvitePassword('');
      setShowInvite(false);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create rep account');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemove = async (m: TeamMember) => {
    if (!confirm(`Remove ${m.display_name} from your team? Their login will stop working with your team, but their call history stays.`)) return;
    try {
      await teamApi.remove(m.rep_user_id);
      toast.success(`${m.display_name} removed`);
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to remove');
    }
  };

  const handleToggleStatus = async (m: TeamMember) => {
    try {
      await teamApi.update(m.rep_user_id, { status: m.status === 'active' ? 'disabled' : 'active' });
      toast.success(m.status === 'active' ? 'Rep disabled' : 'Rep re-enabled');
      load();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center max-w-md mx-auto">
        <AlertCircle className="h-12 w-12 text-amber-500 mb-4" />
        <h2 className="text-2xl font-bold text-foreground mb-2">Team view unavailable</h2>
        <p className="text-muted-foreground mb-6">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background animate-in fade-in duration-700">
      <header className="flex items-center justify-between p-6 shrink-0 z-10 border-b border-border">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Team</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Your reps dial through your Twilio account — no setup needed on their end.
          </p>
        </div>
        <button
          onClick={() => setShowInvite(!showInvite)}
          className="bg-primary hover:bg-primary/90 text-primary-foreground px-5 py-2.5 rounded-xl font-medium flex items-center gap-2 shadow-sm transition-all"
        >
          <UserPlus className="h-4 w-4" /> Add Rep
        </button>
      </header>

      <main className="flex-1 overflow-auto p-6">
        {showInvite && (
          <Card className="mb-6 max-w-lg">
            <CardHeader>
              <CardTitle className="text-lg">New rep account</CardTitle>
              <CardDescription>Create the login, then hand the credentials to your rep.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleInvite} className="space-y-4">
                <input
                  type="email" placeholder="rep@salescloser.ai" value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-background border border-input text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
                <input
                  type="text" placeholder="Display name (e.g. Sarah)" value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-background border border-input text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
                <input
                  type="text" placeholder="Temporary password (min 8 chars)" value={invitePassword}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl bg-background border border-input text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 rounded-xl bg-muted hover:bg-muted/80 text-foreground text-sm font-medium">Cancel</button>
                  <button type="submit" disabled={isInviting} className="px-5 py-2 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-bold flex items-center gap-2 disabled:opacity-50">
                    {isInviting && <Loader2 className="h-4 w-4 animate-spin" />} Create Account
                  </button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <div className="flex justify-center py-40"><Loader2 className="h-8 w-8 animate-spin text-foreground" /></div>
        ) : members.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <Users className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-xl font-semibold text-foreground mb-2">No reps yet</h3>
            <p className="text-muted-foreground max-w-sm mb-6">Add your first rep and they'll be dialing through your Twilio account in minutes.</p>
            <button onClick={() => setShowInvite(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground px-6 py-2.5 rounded-xl font-medium">Add your first rep</button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {members.map((m) => (
              <Card key={m.id} className="flex flex-col">
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary font-bold">
                        {m.display_name?.[0]?.toUpperCase() ?? 'R'}
                      </div>
                      <div>
                        <h3 className="font-semibold text-foreground">{m.display_name}</h3>
                        {m.phone_number && <p className="text-xs text-muted-foreground font-mono">{m.phone_number}</p>}
                        <span className={`text-xs px-2 py-0.5 rounded-full ${m.status === 'active' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}`}>
                          {m.status}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => handleToggleStatus(m)} title={m.status === 'active' ? 'Disable' : 'Enable'} className="p-2 rounded-lg hover:bg-muted text-muted-foreground">
                        {m.status === 'active' ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                      </button>
                      <button onClick={() => handleRemove(m)} title="Remove" className="p-2 rounded-lg hover:bg-red-500/10 text-red-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Stat icon={<Phone className="h-4 w-4" />} label="Calls (7d)" value={m.stats.calls_7d} />
                    <Stat icon={<Clock className="h-4 w-4" />} label="Talk time (7d)" value={`${m.stats.minutes_7d}m`} />
                    <Stat icon={<PhoneCall className="h-4 w-4" />} label="Calls (all)" value={m.stats.calls_total} />
                    <Stat icon={<Target className="h-4 w-4" />} label="Leads dialed" value={`${m.stats.leads_dialed}/${m.stats.leads_total}`} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    {m.stats.campaigns_active} active campaign{m.stats.campaigns_active === 1 ? '' : 's'} · {m.stats.campaigns_total} total
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <div className="bg-muted/40 rounded-xl p-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">{icon}{label}</div>
      <div className="text-lg font-bold font-mono text-foreground">{value}</div>
    </div>
  );
}

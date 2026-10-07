import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Users, Clock, Plus, Wifi, WifiOff, Loader2, FolderOpen, Wallet, CreditCard, CalendarClock, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import CampaignsTable from '@/components/CampaignsTable';
import { campaignsApi, settingsApi, statsApi, followupsApi, type Campaign, type FollowUp } from '@/lib/api';

type TeamPulseRow = { rep_user_id: string; name: string; is_master: boolean; calls: number; connected: number; talk_secs: number };

import CreateCampaignModal from '@/components/CreateCampaignModal';

export default function Dashboard() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stats, setStats] = useState({ totalCampaigns: 0, totalLeads: 0, totalCallsMade: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [isTelnyxConnected, setIsTelnyxConnected] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [teamPulse, setTeamPulse] = useState<TeamPulseRow[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);

  const fetchCampaigns = useCallback(async () => {
    try {
      const { data } = await campaignsApi.list();
      setCampaigns(data);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load campaigns');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const { data } = await settingsApi.get();
      setIsTelnyxConnected(!!data?.telnyx_api_key);
    } catch {
      // Settings may not exist yet
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await statsApi.getDashboard();
      setStats(data);
    } catch {
      // ignore
    }
  }, []);

  const [pulseRange, setPulseRange] = useState<'today' | 'week' | 'month'>('today');

  const fetchTeamPulse = useCallback(async () => {
    try {
      const { data } = await statsApi.getTeamPulse(pulseRange);
      setTeamPulse(data || []);
    } catch {
      // non-fatal
    }
  }, [pulseRange]);

  const fetchFollowUps = useCallback(async () => {
    try {
      const { data } = await followupsApi.list('open');
      setFollowUps(data || []);
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    fetchCampaigns();
    fetchSettings();
    fetchStats();
    fetchTeamPulse();
    fetchFollowUps();
  }, [fetchCampaigns, fetchSettings, fetchStats, fetchTeamPulse, fetchFollowUps]);

  const completeFollowUp = async (id: string) => {
    setFollowUps(prev => prev.filter(f => f.id !== id));
    try { await followupsApi.update(id, { status: 'done' }); } catch { fetchFollowUps(); }
  };
  const dismissFollowUp = async (id: string) => {
    setFollowUps(prev => prev.filter(f => f.id !== id));
    try { await followupsApi.remove(id); } catch { fetchFollowUps(); }
  };

  // Compute stats from real data
  const totalLeads = stats.totalLeads;
  const totalCalled = stats.totalCallsMade;
  const activeCampaigns = campaigns.filter(c => c.status === 'active').length;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      <CreateCampaignModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onCreated={() => { fetchCampaigns(); fetchStats(); }} 
      />

      {/* Header Section */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Welcome back.</h1>
          <p className="text-gray-600 dark:text-gray-400 text-sm mt-1">Here's your calling overview for today.</p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className={cn(
            "px-3 py-1.5 rounded-lg border flex items-center gap-2 text-xs font-medium transition-colors",
            isTelnyxConnected 
              ? 'bg-white dark:bg-[#0F0F12] border-gray-200 dark:border-[#1F1F23] text-gray-700 dark:text-gray-300' 
              : 'bg-white dark:bg-[#0F0F12] border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400'
          )}>
            {isTelnyxConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {isTelnyxConnected ? 'Telnyx Connected' : 'Telnyx Offline'}
          </div>
          <button 
            onClick={() => setIsModalOpen(true)}
            className={cn(
              "flex items-center gap-2",
              "py-2 px-4 rounded-lg",
              "text-sm font-medium",
              "bg-zinc-900 dark:bg-zinc-50",
              "text-zinc-50 dark:text-zinc-900",
              "hover:bg-zinc-800 dark:hover:bg-zinc-200",
              "shadow-sm hover:shadow",
              "transition-all duration-200"
            )}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New Campaign</span>
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Calls Overview Card */}
        <div className="bg-white dark:bg-[#0F0F12] rounded-xl p-6 flex flex-col border border-gray-200 dark:border-[#1F1F23]">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 text-left flex items-center gap-2">
            <Phone className="w-3.5 h-3.5 text-zinc-900 dark:text-zinc-50" />
            Calling Stats
          </h2>
          <div className={cn(
            "w-full",
            "bg-white dark:bg-zinc-900/70",
            "border border-zinc-100 dark:border-zinc-800",
            "rounded-xl shadow-sm backdrop-blur-xl",
          )}>
            {/* Total Balance Section */}
            <div className="p-4 border-b border-zinc-100 dark:border-zinc-800">
              <p className="text-xs text-zinc-600 dark:text-zinc-400">Total Calls Made</p>
              <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{totalCalled}</h1>
            </div>

            {/* Stats List */}
            <div className="p-3">
              <div className="space-y-1">
                {[
                  { icon: Phone, label: 'Campaigns Total', value: String(stats.totalCampaigns), type: 'campaigns' as const },
                  { icon: Users, label: 'CRM Leads', value: String(totalLeads), type: 'leads' as const },
                  { icon: Clock, label: 'Active Campaigns', value: String(activeCampaigns), type: 'active' as const },
                  { icon: CreditCard, label: 'Completion Rate', value: totalLeads > 0 ? `${Math.round((totalCalled / totalLeads) * 100)}%` : '0%', type: 'completion' as const },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className={cn(
                      "group flex items-center justify-between",
                      "p-2 rounded-lg",
                      "hover:bg-zinc-100 dark:hover:bg-zinc-800/50",
                      "transition-all duration-200",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <div className={cn("p-1.5 rounded-lg", {
                        "bg-blue-100 dark:bg-blue-900/30": stat.type === 'campaigns',
                        "bg-emerald-100 dark:bg-emerald-900/30": stat.type === 'leads',
                        "bg-purple-100 dark:bg-purple-900/30": stat.type === 'active',
                        "bg-amber-100 dark:bg-amber-900/30": stat.type === 'completion',
                      })}>
                        <stat.icon className={cn("w-3.5 h-3.5", {
                          "text-blue-600 dark:text-blue-400": stat.type === 'campaigns',
                          "text-emerald-600 dark:text-emerald-400": stat.type === 'leads',
                          "text-purple-600 dark:text-purple-400": stat.type === 'active',
                          "text-amber-600 dark:text-amber-400": stat.type === 'completion',
                        })} />
                      </div>
                      <div>
                        <h3 className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{stat.label}</h3>
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{stat.value}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Callbacks (Follow-ups) Card */}
        {followUps.length > 0 && (
        <div className="bg-white dark:bg-[#0F0F12] rounded-xl p-6 border border-gray-200 dark:border-[#1F1F23]">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-sky-500" />
            Callbacks due
            <span className="text-xs font-semibold text-muted-foreground ml-1">{followUps.length}</span>
          </h2>
          <div className="space-y-2">
            {followUps.slice(0, 6).map((f) => {
              const due = new Date(f.due_at);
              const overdue = due.getTime() < Date.now();
              const dateStr = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              const timeStr = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
              return (
                <div key={f.id} className={cn(
                  'flex items-center gap-3 p-3 rounded-xl border transition-colors',
                  overdue ? 'border-amber-500/40 bg-amber-500/5' : 'border-gray-200 dark:border-[#1F1F23]'
                )}>
                  <div className="flex flex-col items-center min-w-[52px]">
                    <span className={cn('text-xs font-bold', overdue ? 'text-amber-500' : 'text-foreground')}>
                      {overdue ? 'Now' : dateStr}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{timeStr}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {f.lead_name || f.lead_phone || 'Callback'}
                    </p>
                    {f.notes ? (
                      <p className="text-xs text-muted-foreground truncate">{f.notes}</p>
                    ) : f.lead_phone && f.lead_name ? (
                      <p className="text-xs text-muted-foreground">{f.lead_phone}</p>
                    ) : null}
                  </div>
                  <button
                    onClick={() => completeFollowUp(f.id)}
                    title="Mark done"
                    className="p-2 rounded-lg hover:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 transition-colors"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => dismissFollowUp(f.id)}
                    title="Dismiss"
                    className="p-2 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
            {followUps.length > 6 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{followUps.length - 6} more scheduled
              </p>
            )}
          </div>
        </div>
        )}

        {/* Team Pulse Card */}
        <div className="bg-white dark:bg-[#0F0F12] rounded-xl p-6 flex flex-col border border-gray-200 dark:border-[#1F1F23]">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 text-left flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-zinc-900 dark:text-zinc-50" />
            Team Pulse
          </h2>
          <div className="flex gap-1 ml-auto">
            {(['today', 'week', 'month'] as const).map(r => (
              <button
                key={r}
                onClick={() => setPulseRange(r)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${pulseRange === r
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'}`}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {teamPulse.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">No outbound calls logged this {pulseRange === 'today' ? 'day' : pulseRange}.</p>
            ) : teamPulse.map((r) => (
              <div key={r.rep_user_id} className="flex items-center justify-between p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-all duration-200">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 shrink-0">
                    {r.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{r.name}{r.is_master ? ' (you)' : ''}</h3>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{r.talk_secs >= 60 ? `${Math.floor(r.talk_secs / 60)}m ${r.talk_secs % 60}s` : `${r.talk_secs}s`} talk time</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{r.calls} call{r.calls === 1 ? '' : 's'}</span>
                  {r.connected > 0 && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">{r.connected} connected</p>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Campaigns Card */}
        <div className="bg-white dark:bg-[#0F0F12] rounded-xl p-6 flex flex-col border border-gray-200 dark:border-[#1F1F23]">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 text-left flex items-center gap-2">
            <Wallet className="w-3.5 h-3.5 text-zinc-900 dark:text-zinc-50" />
            Quick Actions
          </h2>
          <div className={cn(
            "w-full",
            "bg-white dark:bg-zinc-900/70",
            "border border-zinc-100 dark:border-zinc-800",
            "rounded-xl shadow-sm backdrop-blur-xl",
            "p-4 space-y-3",
          )}>
            <button 
              onClick={() => setIsModalOpen(true)}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-lg",
                "hover:bg-zinc-100 dark:hover:bg-zinc-800/50",
                "transition-all duration-200",
                "text-left"
              )}
            >
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Plus className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Create Campaign</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Start a new calling campaign</p>
              </div>
            </button>
            <button 
              onClick={() => navigate('/dialer')}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-lg",
                "hover:bg-zinc-100 dark:hover:bg-zinc-800/50",
                "transition-all duration-200",
                "text-left"
              )}
            >
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                <Phone className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Manual Dialer</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Make an ad-hoc call</p>
              </div>
            </button>
            <button 
              onClick={() => navigate('/leads')}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-lg",
                "hover:bg-zinc-100 dark:hover:bg-zinc-800/50",
                "transition-all duration-200",
                "text-left"
              )}
            >
              <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <Users className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">View All Leads</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Browse and manage your CRM</p>
              </div>
            </button>
            <button 
              onClick={() => navigate('/connectors')}
              className={cn(
                "w-full flex items-center gap-3 p-3 rounded-lg",
                "hover:bg-zinc-100 dark:hover:bg-zinc-800/50",
                "transition-all duration-200",
                "text-left"
              )}
            >
              <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <Wifi className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Connectors</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Configure Telnyx & integrations</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Campaigns Section */}
      <div className="bg-white dark:bg-[#0F0F12] rounded-xl p-6 flex flex-col items-start justify-start border border-gray-200 dark:border-[#1F1F23]">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-4 text-left flex items-center gap-2">
          <Phone className="w-3.5 h-3.5 text-zinc-900 dark:text-zinc-50" />
          Campaigns
        </h2>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 w-full">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400 dark:text-gray-500" />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center w-full">
            <FolderOpen className="h-12 w-12 text-gray-300 dark:text-gray-600 mb-4" />
            <h3 className="text-base font-semibold text-gray-700 dark:text-gray-300 mb-2">No campaigns yet</h3>
            <p className="text-gray-500 dark:text-gray-400 text-sm mb-6 max-w-sm">Create your first campaign to start importing leads and making calls.</p>
            <button
              onClick={() => setIsModalOpen(true)}
              className={cn(
                "flex items-center gap-2",
                "py-2.5 px-5 rounded-lg",
                "text-sm font-medium",
                "bg-zinc-900 dark:bg-zinc-50",
                "text-zinc-50 dark:text-zinc-900",
                "hover:bg-zinc-800 dark:hover:bg-zinc-200",
                "shadow-sm hover:shadow",
                "transition-all duration-200"
              )}
            >
              <Plus className="h-4 w-4" /> Create Your First Campaign
            </button>
          </div>
        ) : (
          <CampaignsTable campaigns={campaigns} />
        )}
      </div>
    </div>
  );
}

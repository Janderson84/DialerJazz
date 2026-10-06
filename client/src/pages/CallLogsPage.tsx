import { useState, useEffect, useCallback, useMemo } from 'react';
import { PhoneCall, Search, Loader2, Clock, User, Building2, MessageSquare, Play } from 'lucide-react';
import Pagination from '@/components/ui/pagination';
import { usePagination } from '@/hooks/usePagination';
import { toast } from 'sonner';
import { callsApi, campaignsApi, type CallLog, type Campaign } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

const DISPOSITION_COLORS: Record<string, string> = {
  answered: 'bg-foreground/10 text-foreground border-black/10 dark:border-white/10',
  interested: 'bg-foreground/10 text-foreground border-black/10 dark:border-white/10',
  follow_up: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  not_interested: 'bg-zinc-500/20 text-muted-foreground border-zinc-500/30',
  no_answer: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  voicemail: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  busy: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  wrong_number: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  dnc: 'bg-red-500/20 text-red-400 border-red-500/30',
};

function formatPhone(raw?: string | null): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  }
  return raw;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const ITEMS_PER_PAGE = 25;

export default function CallLogsPage() {
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCampaign, setSelectedCampaign] = useState<string>('');
  const [selectedRep, setSelectedRep] = useState<string>('');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [roster, setRoster] = useState<{ rep_user_id: string; display_name: string }[]>([]);
  const { user } = useAuth();
  const MASTER_ID = 'a4d41720-59e1-4850-8b15-e8841872e702';
  const isMaster = user?.id === MASTER_ID;

  const { currentPage, totalPages, setCurrentPage, resetPage, setMeta, perPage } =
    usePagination({ perPage: ITEMS_PER_PAGE });
  const [meta, setMetaState] = useState<{ total: number } | null>(null);

  useEffect(() => {
    if (!isMaster) return;
    import('@/lib/team').then(({ teamApi }) => teamApi.list()
      .then(({ data }: any) => setRoster((data || []).map((m: any) => ({ rep_user_id: m.rep_user_id ?? m.id, display_name: m.display_name || 'Rep' }))))
      .catch(() => {}))
  }, [isMaster]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [logsRes, campaignsRes] = await Promise.all([
        callsApi.list({
          campaign_id: selectedCampaign || undefined,
          rep: isMaster ? (selectedRep || undefined) : undefined,
          from: fromDate || undefined,
          to: toDate || undefined,
          page: currentPage,
          per_page: perPage,
        }),
        campaignsApi.list({ per_page: 100 })
      ]);
      setCallLogs(logsRes.data);
      setMeta(logsRes.meta);
      setMetaState({ total: (logsRes.meta as any)?.total ?? 0 });
      setCampaigns(campaignsRes.data);
    } catch (error: any) {
      toast.error(error.message || 'Failed to fetch call logs');
    } finally {
      setIsLoading(false);
    }
  }, [selectedCampaign, selectedRep, fromDate, toDate, isMaster, currentPage, perPage, setMeta]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Client-side search within the current server page
  const filteredLogs = useMemo(() =>
    callLogs.filter(log => {
      const searchLower = searchTerm.toLowerCase();
      const leadName = [log.lead?.first_name, log.lead?.last_name].filter(Boolean).join(' ').toLowerCase();
      const leadPhone = log.lead?.phone || '';
      const leadCompany = log.lead?.company?.toLowerCase() || '';

      return leadName.includes(searchLower) ||
             leadPhone.includes(searchLower) ||
             leadCompany.includes(searchLower);
    }),
    [callLogs, searchTerm]
  );

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-display text-foreground mb-1">Call History</h1>
          <p className="text-muted-foreground tracking-body">View all your past calls and dispositions.</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground text-opacity-70" />
          <input
            placeholder="Search by name, phone, or company..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-[0.85rem] bg-surface border border-black/5 dark:border-white/5 text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30 transition-all shadow-sm"
          />
        </div>
        <select
          value={selectedCampaign}
          onChange={(e) => { setSelectedCampaign(e.target.value); resetPage(); }}
          className="px-4 py-2.5 rounded-[0.85rem] bg-surface border border-black/5 dark:border-white/5 text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30 transition-all shadow-sm"
        >
          <option value="">All Campaigns</option>
          {campaigns.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        {isMaster && (
          <select
            value={selectedRep}
            onChange={(e) => { setSelectedRep(e.target.value); resetPage(); }}
            className="px-4 py-2.5 rounded-[0.85rem] bg-surface border border-black/5 dark:border-white/5 text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30 transition-all shadow-sm"
          >
            <option value="">All Reps</option>
            {roster.map(r => (
              <option key={r.rep_user_id} value={r.rep_user_id}>{r.display_name}</option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => { setFromDate(e.target.value); resetPage(); }}
            className="px-3 py-2.5 rounded-[0.85rem] bg-surface border border-black/5 dark:border-white/5 text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30 transition-all shadow-sm"
          />
          <span className="text-muted-foreground text-sm">–</span>
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => { setToDate(e.target.value); resetPage(); }}
            className="px-3 py-2.5 rounded-[0.85rem] bg-surface border border-black/5 dark:border-white/5 text-foreground focus:outline-none focus:ring-1 focus:ring-foreground/20 focus:border-foreground/30 transition-all shadow-sm"
          />
          {(fromDate || toDate) && (
            <button
              onClick={() => { setFromDate(''); setToDate(''); resetPage(); }}
              className="px-3 py-2.5 rounded-[0.85rem] text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Result count for the selected view */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <PhoneCall className="h-3.5 w-3.5" />
        <span>
          <span className="font-semibold text-foreground">{meta?.total ?? 0}</span>
          {' '}call{(meta?.total ?? 0) === 1 ? '' : 's'} in view
          {(fromDate || toDate || selectedRep || selectedCampaign) && ' (filtered)'}
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-foreground" />
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="p-4 rounded-[1.5rem] bg-surface border border-black/5 dark:border-white/5 mb-4 shadow-sm">
            <PhoneCall className="h-10 w-10 text-muted-foreground text-opacity-50" />
          </div>
          <h3 className="text-lg font-semibold text-muted-foreground mb-2">No call logs yet</h3>
          <p className="text-muted-foreground text-opacity-70 max-w-sm">
            Start dialing leads from a campaign to see your call history here.
          </p>
        </div>
      ) : (
        <>
          <div className="bg-surface border border-black/5 dark:border-white/5 rounded-[1.5rem] overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-muted-foreground whitespace-nowrap">
                <thead className="bg-muted text-xs uppercase text-muted-foreground text-opacity-70">
                  <tr>
                    <th className="px-6 py-4 font-semibold">Date</th>
                    {isMaster && <th className="px-6 py-4 font-semibold">Rep</th>}
                    <th className="px-6 py-4 font-semibold">Lead</th>
                    <th className="px-6 py-4 font-semibold">Number</th>
                    <th className="px-6 py-4 font-semibold">Campaign</th>
                    <th className="px-6 py-4 font-semibold">Duration</th>
                    <th className="px-6 py-4 font-semibold">Disposition</th>
                    <th className="px-6 py-4 font-semibold">Audio</th>
                    <th className="px-6 py-4 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-muted-foreground text-opacity-70" />
                          <span className="text-foreground">{formatDate(log.created_at)}</span>
                        </div>
                      </td>
                      {isMaster && (
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-xs font-medium text-foreground">
                            <User className="h-3 w-3" />
                            {log.rep_name || 'You'}
                          </span>
                        </td>
                      )}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                            <User className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="font-medium text-foreground">
                              {[log.lead?.first_name, log.lead?.last_name].filter(Boolean).join(' ') || 'Unknown'}
                            </div>
                            <div className="text-xs text-muted-foreground text-opacity-70 flex items-center gap-1">
                              <Building2 className="h-3 w-3" />
                              {log.lead?.company || log.lead?.phone}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-foreground font-mono text-sm">
                          {formatPhone(log.direction === 'inbound' ? log.from_number : log.to_number) || '—'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {log.campaign?.name || '-'}
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-foreground font-mono">
                          {formatDuration(log.duration_seconds)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {log.disposition ? (
                          <span className={`px-2.5 py-1 rounded-full text-xs font-medium border ${DISPOSITION_COLORS[log.disposition] || 'bg-zinc-500/20 text-muted-foreground border-zinc-500/30'}`}>
                            {log.disposition.replace('_', ' ')}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-opacity-70">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {log.recording_url ? (
                          <a
                            href={log.recording_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-medium hover:bg-indigo-500/25 transition-colors"
                          >
                            <Play className="h-3 w-3" />
                            Play
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-opacity-40">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 max-w-xs">
                        {log.notes ? (
                          <div className="flex items-start gap-2">
                            <MessageSquare className="h-4 w-4 text-muted-foreground text-opacity-70 mt-0.5 shrink-0" />
                            <span className="text-xs text-muted-foreground truncate block">
                              {log.notes}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-opacity-50">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
        </>
      )}
    </div>
  );
}

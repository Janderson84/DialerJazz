import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare, Send, Clock, CheckCheck, XCircle, X,
  Plus, Pencil, Trash2, ChevronLeft, CircleDot, CircleCheck,
  Timer, Zap, Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { smsApi, type SmsMessage, type SmsTemplate, type SmsAutoReply } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/radix-select';

type TabKey = 'messages' | 'templates' | 'auto';

const TRIGGER_LABELS: Record<string, string> = {
  inbound_text: 'New inbound text',
  missed_call: 'Missed call',
  voicemail: 'Voicemail received',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function MessagesPage() {
  const [tab, setTab] = useState<TabKey>('messages');
  const [newOpen, setNewOpen] = useState(false);

  // ── threads ──
  const [threads, setThreads] = useState<SmsMessage[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [openPeer, setOpenPeer] = useState<string | null>(null);
  const [threadMsgs, setThreadMsgs] = useState<SmsMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const loadThreads = useCallback(async () => {
    try {
      const { data } = await smsApi.listThreads();
      setThreads(data || []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load conversations');
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // Poll for new inbound messages so threads update without manual refresh
  useEffect(() => {
    const id = setInterval(loadThreads, 10_000);
    return () => clearInterval(id);
  }, [loadThreads]);

  // ── thread detail ──
  const openThread = useCallback(async (peer: string) => {
    setOpenPeer(peer);
    setThreadLoading(true);
    try {
      const { data } = await smsApi.getThread(peer);
      setThreadMsgs(data || []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load thread');
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const peerStatus = useMemo(() => {
    const t = threads.find((x) => (x.direction === 'outbound' ? x.to_number : x.from_number) === openPeer);
    return t?.conversation_status || 'open';
  }, [threads, openPeer]);

  const togglePeerStatus = async () => {
    if (!openPeer) return;
    const next = peerStatus === 'open' ? 'closed' : 'open';
    try {
      await smsApi.setThreadStatus(openPeer, next);
      toast.success(`Conversation marked ${next}`);
      await Promise.all([loadThreads(), openThread(openPeer)]);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update status');
    }
  };

  return (
    <div className="flex flex-col h-full bg-background animate-in fade-in duration-700">
      <header className="flex items-center justify-between p-6 shrink-0 z-10 border-b border-border">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Messages</h1>
          <p className="text-muted-foreground text-sm mt-1">One-to-one texting from your own number.</p>
        </div>
      </header>

      <div className="flex-1 overflow-hidden p-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="h-full flex flex-col">
          <TabsList className="w-fit mb-4">
            <TabsTrigger value="messages" className="gap-1.5"><MessageSquare className="h-4 w-4" /> Conversations</TabsTrigger>
            <TabsTrigger value="templates" className="gap-1.5"><Copy className="h-4 w-4" /> Templates</TabsTrigger>
            <TabsTrigger value="auto" className="gap-1.5"><Zap className="h-4 w-4" /> Auto-Replies</TabsTrigger>
          </TabsList>

          <TabsContent value="messages" className="flex-1 overflow-hidden mt-0">
            {openPeer ? (
              <ThreadView
                peer={openPeer}
                msgs={threadMsgs}
                loading={threadLoading}
                status={peerStatus}
                onBack={() => { setOpenPeer(null); loadThreads(); }}
                onToggleStatus={togglePeerStatus}
                onSent={() => openThread(openPeer)}
              />
            ) : (
              <ThreadList
                threads={threads}
                loading={threadsLoading}
                onOpen={openThread}
                onNew={() => setNewOpen(true)}
              />
            )}
          </TabsContent>

          <TabsContent value="templates" className="flex-1 overflow-auto mt-0">
            <TemplatesTab />
          </TabsContent>

          <TabsContent value="auto" className="flex-1 overflow-auto mt-0">
            <AutoRepliesTab />
          </TabsContent>
        </Tabs>
      </div>

      <NewMessageDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSent={async (peer) => {
          setNewOpen(false);
          await loadThreads();
          openThread(peer);
        }}
      />
    </div>
  );
}

// ══════════════════ New message dialog (type a number + send) ═══════

export function NewMessageDialog({ open, onClose, onSent, initialTo }: {
  open: boolean;
  onClose: () => void;
  onSent: (peer: string) => void;
  initialTo?: string;
}) {
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (open) { setTo(initialTo || ''); setBody(''); }
  }, [open, initialTo]);

  useEffect(() => {
    if (open) smsApi.listTemplates().then(({ data }) => setTemplates(data || [])).catch(() => {});
  }, [open]);

  const clean = to.replace(/[^\d+]/g, '');
  const valid = /^\+?1?\d{10,11}$/.test(clean);

  const send = async () => {
    setSending(true);
    try {
      await smsApi.send({ to, body });
      toast.success('Message sent');
      onSent(clean.startsWith('+') ? clean : `+1${clean.length === 10 ? clean : clean.replace(/^1/, '')}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="tel"
            placeholder="Phone number — e.g. 555 123 4567"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && valid && body.trim()) send(); }}
            autoFocus
          />
          {templates.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setBody(t.body)}
                  className="px-2.5 py-1 rounded-full text-xs font-medium border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <textarea
            placeholder="Type your message… (Enter to send)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (valid && body.trim() && !sending) send();
              }
            }}
            maxLength={1000}
            className="w-full min-h-[100px] rounded-xl border border-border bg-transparent p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={send} disabled={sending || !valid || !body.trim()}>
              <Send className="h-4 w-4 mr-1.5" /> {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ══════════════════ Thread list ═════════════════════════════════════

function ThreadList({ threads, loading, onOpen, onNew }: {
  threads: SmsMessage[];
  loading: boolean;
  onOpen: (peer: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Conversations</h2>
        <Button size="sm" onClick={onNew} className="gap-1.5"><Plus className="h-4 w-4" /> New message</Button>
      </div>
      <Card className="flex-1 overflow-hidden">
        <CardContent className="p-0 h-full overflow-y-auto">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
          ) : threads.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              No conversations yet. Send your first message after a call, or from a lead.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {threads.map((t) => {
                const peer = t.direction === 'outbound' ? t.to_number : t.from_number;
                const isInboundLast = t.direction === 'inbound';
                return (
                  <li key={peer} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                      onClick={() => onOpen(peer)}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-foreground">{peer}</span>
                        {t.conversation_status === 'closed' && (
                          <Badge variant="outline" className="text-xs text-muted-foreground">closed</Badge>
                        )}
                        {t.status === 'scheduled' && (
                          <Badge variant="outline" className="text-xs text-amber-500">scheduled</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground truncate mt-0.5">
                        {isInboundLast && <span className="font-medium text-foreground">They: </span>}
                        {t.body}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">{formatTime(t.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ══════════════════ Thread view + composer ══════════════════════════

function ThreadView({ peer, msgs, loading, status, onBack, onToggleStatus, onSent }: {
  peer: string;
  msgs: SmsMessage[];
  loading: boolean;
  status: 'open' | 'closed';
  onBack: () => void;
  onToggleStatus: () => void;
  onSent: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [scheduleAt, setScheduleAt] = useState<string>('');
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    smsApi.listTemplates().then(({ data }) => setTemplates(data || [])).catch(() => {});
  }, []);

  // Poll the thread so incoming replies auto-appear (5s)
  const [liveMsgs, setLiveMsgs] = useState<SmsMessage[] | null>(null);
  const shownMsgs = liveMsgs ?? msgs;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [shownMsgs.length]);

  useEffect(() => {
    setLiveMsgs(null);
    if (!peer) return;
    const id = setInterval(async () => {
      try {
        const { data } = await smsApi.getThread(peer);
        setLiveMsgs(data || []);
      } catch { /* keep last state on transient errors */ }
    }, 5_000);
    return () => clearInterval(id);
  }, [peer]);

  const applyTemplate = (name: string) => {
    const tpl = templates.find((t) => t.name === name);
    if (tpl) setDraft(tpl.body);
  };

  const send = async () => {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await smsApi.send({ to: peer, body: draft, scheduled_for: scheduleAt || undefined });
      toast.success(scheduleAt ? 'Message scheduled' : 'Message sent');
      setDraft('');
      setScheduleAt('');
      onSent();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 mb-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1"><ChevronLeft className="h-4 w-4" /> Back</Button>
        <span className="font-mono font-bold text-lg text-foreground">{peer}</span>
        <Badge variant="outline" className={status === 'open' ? 'text-emerald-500 border-emerald-500/30' : 'text-muted-foreground'}>
          {status}
        </Badge>
        <Button variant="outline" size="sm" onClick={onToggleStatus} className="ml-auto gap-1.5">
          {status === 'open' ? <><CircleCheck className="h-4 w-4" /> Mark closed</> : <><CircleDot className="h-4 w-4" /> Reopen</>}
        </Button>
      </div>

      <Card className="flex-1 overflow-hidden mb-3">
        <CardContent className="p-4 h-full overflow-y-auto" ref={undefined}>
          {loading ? (
            <div className="h-full grid place-items-center text-muted-foreground text-sm">Loading…</div>
          ) : shownMsgs.length === 0 ? (
            <div className="h-full grid place-items-center text-muted-foreground text-sm">No messages with this contact yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {shownMsgs.map((m) => {
                const mine = m.direction === 'outbound';
                const failed = m.status === 'failed';
                const cancelled = m.status === 'cancelled';
                const scheduled = m.status === 'scheduled';
                return (
                  <div key={m.id} className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${mine ? 'self-end bg-primary text-primary-foreground' : 'self-start bg-muted'}`}>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                    <div className={`flex items-center gap-1 mt-1 text-[10px] ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                      {scheduled ? <Timer className="h-3 w-3" /> : failed ? <XCircle className="h-3 w-3" /> : cancelled ? <XCircle className="h-3 w-3" /> : <CheckCheck className="h-3 w-3" />}
                      {formatTime(m.created_at)}
                      {scheduled && m.scheduled_for && ` · sends ${formatTime(m.scheduled_for)}`}
                      {failed && ' · failed'}
                      {cancelled && ' · cancelled'}
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Composer */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            {templates.length > 0 && (
              <Select onValueChange={applyTemplate}>
                <SelectTrigger className="w-44 h-8 text-xs"><Clock className="h-3 w-3 mr-1" /> Insert template</SelectTrigger>
                <SelectContent>
                  {templates.map((t) => <SelectItem key={t.id} value={t.name}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="w-56 h-8 text-xs"
              title="Leave empty to send now"
            />
            {scheduleAt && (
              <Button variant="ghost" size="sm" onClick={() => setScheduleAt('')}><X className="h-3 w-3" /> send now</Button>
            )}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim() && !sending) send();
                }
              }}
              placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
              className="flex-1 min-h-[44px] max-h-32 resize-none rounded-xl border border-border bg-transparent p-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/20"
            />
            <Button onClick={send} disabled={sending || !draft.trim()} className="h-11 gap-1.5">
              <Send className="h-4 w-4" /> {scheduleAt ? 'Schedule' : 'Send'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ══════════════════ Templates tab ═══════════════════════════════════

function TemplatesTab() {
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SmsTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await smsApi.listTemplates();
      setTemplates(data || []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const remove = async (t: SmsTemplate) => {
    try {
      await smsApi.deleteTemplate(t.id);
      toast.success('Template deleted');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to delete');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Message templates</h2>
        <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5"><Plus className="h-4 w-4" /> New template</Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Use variables like <code className="font-mono bg-muted px-1 rounded">{'{{first_name}}'}</code>, <code className="font-mono bg-muted px-1 rounded">{'{{company}}'}</code>, <code className="font-mono bg-muted px-1 rounded">{'{{rep_name}}'}</code> — they fill in per contact when sent from a lead.
      </p>

      {loading ? (
        <div className="text-muted-foreground text-sm py-8 text-center">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="text-muted-foreground text-sm py-8 text-center">No templates yet.</div>
      ) : (
        <div className="grid gap-2">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">{t.name}</p>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{t.body}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(t)} title="Edit"><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(t)} title="Delete"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <TemplateDialog
        open={creating || !!editing}
        template={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
        onSaved={() => { setCreating(false); setEditing(null); load(); }}
      />
    </div>
  );
}

function TemplateDialog({ open, template, onClose, onSaved }: {
  open: boolean;
  template: SmsTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(template?.name || '');
      setBody(template?.body || '');
    }
  }, [open, template]);

  const save = async () => {
    if (!name.trim() || !body.trim()) return toast.error('Name and body are required');
    setSaving(true);
    try {
      if (template) await smsApi.updateTemplate(template.id, { name, body });
      else await smsApi.createTemplate(name, body);
      toast.success(template ? 'Template updated' : 'Template created');
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{template ? 'Edit template' : 'New template'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <textarea
            placeholder="Message body… use {{first_name}}, {{company}}, {{rep_name}}"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            className="w-full min-h-[110px] rounded-xl border border-border bg-transparent p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ══════════════════ Auto-replies tab ════════════════════════════════

function AutoRepliesTab() {
  const [rules, setRules] = useState<SmsAutoReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await smsApi.listAutoReplies();
      setRules(data || []);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load auto-replies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (r: SmsAutoReply) => {
    try {
      await smsApi.updateAutoReply(r.id, { active: !r.active });
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update');
    }
  };

  const remove = async (r: SmsAutoReply) => {
    try {
      await smsApi.deleteAutoReply(r.id);
      toast.success('Auto-reply deleted');
      load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to delete');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-widest">Auto-replies</h2>
        <Button size="sm" onClick={() => setCreating(true)} className="gap-1.5"><Plus className="h-4 w-4" /> New auto-reply</Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        Automatic texts for inbound messages, missed calls, and voicemails — with business-hours control.
      </p>

      {loading ? (
        <div className="text-muted-foreground text-sm py-8 text-center">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="text-muted-foreground text-sm py-8 text-center">No auto-replies yet.</div>
      ) : (
        <div className="grid gap-2">
          {rules.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-foreground">{r.name}</p>
                    <Badge variant="outline" className="text-xs">{TRIGGER_LABELS[r.trigger_event] || r.trigger_event}</Badge>
                    <Badge variant="outline" className="text-xs">{r.schedule_mode === 'always' ? 'any time' : r.schedule_mode === 'business_hours' ? 'business hours' : 'after hours'}</Badge>
                    {!r.active && <Badge variant="outline" className="text-xs text-muted-foreground">paused</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{r.body}</p>
                </div>
                <div className="flex gap-1 shrink-0 items-center">
                  <Button variant={r.active ? 'secondary' : 'outline'} size="sm" onClick={() => toggleActive(r)}>
                    {r.active ? 'Pause' : 'Activate'}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(r)} title="Delete"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AutoReplyDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => { setCreating(false); load(); }}
      />
    </div>
  );
}

function AutoReplyDialog({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<SmsAutoReply['trigger_event']>('inbound_text');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<SmsAutoReply['schedule_mode']>('always');
  const [start, setStart] = useState('9');
  const [end, setEnd] = useState('17');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setName(''); setTrigger('inbound_text'); setBody(''); setMode('always'); setStart('9'); setEnd('17'); }
  }, [open]);

  const save = async () => {
    if (!name.trim() || !body.trim()) return toast.error('Name and body are required');
    setSaving(true);
    try {
      await smsApi.createAutoReply({
        name, trigger_event: trigger, body,
        schedule_mode: mode,
        business_hours: mode === 'always' ? undefined : { start, end, tz: 'America/Chicago' },
      });
      toast.success('Auto-reply created');
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New auto-reply</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Rule name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Trigger</label>
              <Select value={trigger} onValueChange={(v: string) => setTrigger(v as SmsAutoReply['trigger_event'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="inbound_text">{TRIGGER_LABELS.inbound_text}</SelectItem>
                  <SelectItem value="missed_call">{TRIGGER_LABELS.missed_call}</SelectItem>
                  <SelectItem value="voicemail">{TRIGGER_LABELS.voicemail}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Active hours</label>
              <Select value={mode} onValueChange={(v: string) => setMode(v as SmsAutoReply['schedule_mode'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Any time</SelectItem>
                  <SelectItem value="business_hours">Business hours only</SelectItem>
                  <SelectItem value="after_hours">After hours only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {mode !== 'always' && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Hours</span>
              <Input type="number" min={0} max={23} value={start} onChange={(e) => setStart(e.target.value)} className="w-20" />
              <span className="text-muted-foreground">to</span>
              <Input type="number" min={0} max={23} value={end} onChange={(e) => setEnd(e.target.value)} className="w-20" />
              <span className="text-muted-foreground">(America/Chicago)</span>
            </div>
          )}
          <textarea
            placeholder="Auto-reply message…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            className="w-full min-h-[90px] rounded-xl border border-border bg-transparent p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-foreground/20"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={saving}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

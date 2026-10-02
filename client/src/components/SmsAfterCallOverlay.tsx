/**
 * SmsAfterCallOverlay — shown after a disposition is saved in the campaign
 * dialer. Lets the rep pick a template (or write freely) and text the lead
 * they just spoke with, in one-to-one style. Skippable.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, MessageSquare, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { smsApi, type SmsTemplate } from '@/lib/api';

interface SmsAfterCallOverlayProps {
  visible: boolean;
  leadName: string;
  leadPhone: string;
  leadId: string;
  onDone: () => void;   // continue (swipe to next lead etc.)
}

export default function SmsAfterCallOverlay({
  visible, leadName, leadPhone, leadId, onDone,
}: SmsAfterCallOverlayProps) {
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [draft, setDraft] = useState('');
  const [selectedTpl, setSelectedTpl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft('');
    setSelectedTpl(null);
    smsApi.listTemplates()
      .then(({ data }) => setTemplates(data || []))
      .catch(() => {});
  }, [visible, leadId]);

  const renderPreview = (body: string) =>
    body
      .replace(/\{\{\s*first_name\s*\}\}/gi, leadName.split(' ')[0] || 'there')
      .replace(/\{\{\s*last_name\s*\}\}/gi, leadName.split(' ').slice(1).join(' '))
      .replace(/\{\{\s*\w+\s*\}\}/gi, '');

  const send = async () => {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await smsApi.send({ to: leadPhone, body: draft, lead_id: leadId, template_id: selectedTpl || undefined });
      toast.success(`Text sent to ${leadPhone}`);
      onDone();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to send text');
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
        >
          <motion.div
            initial={{ scale: 0.95, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 8 }}
            className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-2xl"
          >
            <div className="flex items-center gap-2.5 mb-3">
              <div className="h-9 w-9 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <MessageSquare className="h-4.5 w-4.5" />
              </div>
              <div>
                <p className="font-bold text-foreground text-sm">Send a text?</p>
                <p className="text-xs text-muted-foreground">{leadName} · {leadPhone}</p>
              </div>
            </div>

            {templates.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mb-3">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setSelectedTpl(t.id); setDraft(t.body); }}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      selectedTpl === t.id
                        ? 'bg-foreground text-background border-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
                    }`}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}

            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type or pick a template…"
              maxLength={1000}
              className="w-full min-h-[96px] rounded-xl border border-border bg-transparent p-3 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-foreground/20 mb-3"
            />
            {draft && (
              <p className="text-[11px] text-muted-foreground mb-3 -mt-2">
                Sends as: <span className="font-mono">{renderPreview(draft).slice(0, 80)}{renderPreview(draft).length > 80 ? '…' : ''}</span>
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={onDone}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors flex items-center gap-1.5"
              >
                <SkipForward className="h-4 w-4" /> Not now
              </button>
              <button
                onClick={send}
                disabled={sending || !draft.trim()}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-40 hover:bg-primary/90 transition-colors flex items-center gap-1.5"
              >
                <Send className="h-4 w-4" /> {sending ? 'Sending…' : 'Send text'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

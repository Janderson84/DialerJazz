import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface DispositionOption {
  value: string;
  label: string;
  color: string;
  emoji: string;
  primary?: boolean;
}

interface DispositionOverlayProps {
  visible: boolean;
  dispositions: DispositionOption[];
  isDisposing: boolean;
  onSelect: (label: string) => void;
  onRedial?: () => void;
  /** If set, shows a "Schedule callback" row: rep picks a time, fires with ISO due date + notes. */
  onScheduleCallback?: (dueAtIso: string, notes: string) => void;
}

/**
 * DispositionOverlay — bottom-sheet UI that appears after a call ends.
 * Provides quick-tap disposition buttons (Interested, No Answer, DNC, etc.).
 */
export default function DispositionOverlay({
  visible,
  dispositions,
  isDisposing,
  onSelect,
  onRedial,
  onScheduleCallback,
}: DispositionOverlayProps) {
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleWhen, setScheduleWhen] = useState('');
  const [scheduleNotes, setScheduleNotes] = useState('');

  useEffect(() => {
    if (visible) {
      setShowSchedule(false);
      setScheduleWhen('');
      setScheduleNotes('');
    }
  }, [visible]);

  const submitSchedule = () => {
    if (!scheduleWhen || !onScheduleCallback) return;
    onScheduleCallback(new Date(scheduleWhen).toISOString(), scheduleNotes.trim());
    setShowSchedule(false);
  };
  const primaryDispositions = dispositions.filter((d) => d.primary);
  const secondaryDispositions = dispositions.filter((d) => !d.primary);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%', opacity: 0 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
          className="absolute inset-x-0 bottom-0 top-[30%] bg-surface backdrop-blur-md rounded-t-[2.5rem] border-t-2 border-border z-50 shadow-[0_-20px_50px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden"
        >
          {/* Pull handle */}
          <div className="w-16 h-1.5 bg-white/20 rounded-full mx-auto mt-4 mb-6" />

          <div className="px-6 flex-1 flex flex-col">
            <h3 className="text-xl font-extrabold text-foreground mb-2 text-center">
              What's the outcome?
            </h3>
            <p className="text-muted-foreground text-sm text-center mb-8">
              Select disposition to save and continue.
            </p>

            {onRedial && (
              <div className="mb-4">
                <button
                  onClick={onRedial}
                  disabled={isDisposing}
                  className="w-full flex items-center justify-center gap-2 p-3.5 rounded-2xl bg-emerald-600/15 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-600/25 active:scale-[0.98] transition-all disabled:opacity-50"
                >
                  <span className="text-lg">🔁</span>
                  <span className="text-sm font-bold">Redial now</span>
                  <span className="text-[11px] opacity-70">— call them right back</span>
                </button>
              </div>
            )}
            {onScheduleCallback && (
              <div className="mb-4">
                {!showSchedule ? (
                  <button
                    onClick={() => setShowSchedule(true)}
                    disabled={isDisposing}
                    className="w-full flex items-center justify-center gap-2 p-3.5 rounded-2xl bg-sky-600/15 border border-sky-500/40 text-sky-400 hover:bg-sky-600/25 active:scale-[0.98] transition-all disabled:opacity-50"
                  >
                    <span className="text-lg">📅</span>
                    <span className="text-sm font-bold">Schedule callback</span>
                    <span className="text-[11px] opacity-70">— book a time to try again</span>
                  </button>
                ) : (
                  <div className="p-4 rounded-2xl bg-muted border border-border space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-foreground">When should we call back?</span>
                      <button onClick={() => setShowSchedule(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {[
                        { label: 'In 1 hour', hours: 1 },
                        { label: 'Later today', hours: 4 },
                        { label: 'Tomorrow AM', hours: 18 },
                      ].map((q) => (
                        <button
                          key={q.label}
                          onClick={() => setScheduleWhen(new Date(Date.now() + q.hours * 3600_000).toISOString().slice(0, 16))}
                          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                            scheduleWhen === new Date(Date.now() + q.hours * 3600_000).toISOString().slice(0, 16)
                              ? 'bg-sky-600 text-white border-sky-600'
                              : 'bg-background border-border text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {q.label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="datetime-local"
                      value={scheduleWhen}
                      onChange={(e) => setScheduleWhen(e.target.value)}
                      className="w-full p-2.5 rounded-xl bg-background border border-border text-sm text-foreground"
                    />
                    <input
                      type="text"
                      placeholder="Note for the callback (optional)"
                      value={scheduleNotes}
                      onChange={(e) => setScheduleNotes(e.target.value)}
                      className="w-full p-2.5 rounded-xl bg-background border border-border text-sm text-foreground"
                    />
                    <button
                      onClick={submitSchedule}
                      disabled={!scheduleWhen}
                      className="w-full p-3 rounded-xl bg-sky-600 text-white text-sm font-bold disabled:opacity-40 active:scale-[0.98] transition-all"
                    >
                      Save callback
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-4">
              {/* Primary Row */}
              <div className="grid grid-cols-3 gap-3">
                {primaryDispositions.map((d) => (
                  <button
                    key={d.label}
                    onClick={() => onSelect(d.label)}
                    disabled={isDisposing}
                    className="flex flex-col items-center justify-center gap-2 p-4 rounded-2xl bg-muted border border-border hover:bg-muted hover:bg-muted/80 active:scale-95 transition-all disabled:opacity-50"
                  >
                    <span className="text-2xl">{d.emoji}</span>
                    <span className="text-xs font-bold text-foreground text-center leading-tight">
                      {d.label}
                    </span>
                  </button>
                ))}
              </div>
              <div className="h-px w-full bg-muted my-2" />
              {/* Secondary Row */}
              <div className="grid grid-cols-3 gap-3 flex-1 pb-6">
                {secondaryDispositions.map((d) => (
                  <button
                    key={d.label}
                    onClick={() => onSelect(d.label)}
                    disabled={isDisposing}
                    className="flex flex-col items-center justify-center gap-2 p-3 rounded-2xl bg-transparent border border-border hover:bg-muted active:scale-95 transition-all text-muted-foreground hover:text-foreground"
                  >
                    <span className="text-xl opacity-70">{d.emoji}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-center">
                      {d.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

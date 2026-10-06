/**
 * TwilioContext — Global React Context that owns the Twilio Voice Device.
 *
 * Mirrors the same interface as TelnyxContext so VoiceContext can
 * delegate to either one transparently.
 */

import {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import loglevel from 'loglevel';
import { Device, Call } from '@twilio/voice-sdk';

// Mic id proven openable at init; used per-dial to hand Twilio fresh tracks.
let preferredMicId: string | undefined;

// Module-level diag sink: usable from any scope (initConnection AND dial()).
// It previously lived inside initConnection, which made every dial() throw
// ReferenceError: diag is not defined at connect time (stuck-on-DIALING bug).
const diag = (event: string, detail?: string) => {
  try {
    fetch('/api/diag/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, detail }),
    }).catch(() => {});
  } catch { /* noop */ }
};

// APP-LEVEL instrumentation: wrap Device.prototype.connect so every connect
// attempt is visible regardless of which SDK instance is alive in the page.
try {
  (Device as any).__scModuleTag = 'twilio-sdk-' + Date.now();
  (globalThis as any).__scLatestSdkTag = (Device as any).__scModuleTag;
  const _origConnect = Device.prototype.connect as any;
  (Device.prototype as any).connect = function (...args: any[]) {
    try {
      fetch('/api/diag/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'device.connect.wrapped', detail: `proto=${Object.getPrototypeOf(this).constructor.name}` }),
      }).catch(() => {});
    } catch { /* noop */ }
    const p = _origConnect.apply(this, args);
    try {
      Promise.resolve(p).then(
        (call: any) => fetch('/api/diag/event', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'device.connect.wrapped.resolved', detail: `params=${JSON.stringify(call?.parameters || {})}`.slice(0, 250) }),
        }).catch(() => {}),
        (err: any) => fetch('/api/diag/event', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'device.connect.wrapped.rejected', detail: String(err?.message || err).slice(0, 250) }),
        }).catch(() => {})
      );
    } catch { /* noop */ }
    return p;
  };
  debugLog('[TwilioContext] Device.connect wrapped for diagnostics');
} catch (wrapErr) {
  console.error('[TwilioContext] Failed to wrap Device.connect:', wrapErr);
}
import { twilioApi, settingsApi, callsApi } from '@/lib/api';
import { useAuth } from './AuthContext';


import type { ConnectionStatus, CallState, QualityMetrics } from './TelnyxContext';

// Diagnostic logging — silenced in production; set localStorage.debugVoice = '1' to enable.
function debugLog(...args: unknown[]) {
  try { if (localStorage.getItem('debugVoice') === '1') console.log(...args); } catch { /* noop */ }
}


// ── Types ────────────────────────────────────────────────────────────
export interface TwilioContextValue {
  // Connection
  connectionStatus: ConnectionStatus;
  initConnection: () => Promise<void>;
  disconnect: () => void;
  sipConfigured: boolean;

  // Primary call
  primaryCall: Call | null;
  primaryCallState: CallState;
  primaryCallDuration: number;
  isMuted: boolean;
  isHeld: boolean;

  // Incoming call
  incomingCall: Call | null;
  incomingCallerNumber: string;
  incomingCallerName: string;

  // Held call (not fully supported in Twilio browser SDK, but keeping interface parity)
  heldCall: Call | null;
  heldCallDuration: number;
  heldCallerNumber: string;

  // Actions
  dial: (destinationNumber: string, callerNumber?: string, opts?: { autoLog?: boolean }) => void;
  hangup: () => void;
  answerIncoming: () => void;
  rejectIncoming: () => void;
  holdAndAnswer: () => void;
  hangupAndResume: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDTMF: (digit: string) => void;

  // Navigation
  activeCallRoute: string | null;
  setActiveCallRoute: (route: string | null) => void;

  // Remote party of the active/last primary call
  activeCallNumber: string | null;

  // Errors
  error: string | null;
  sipError: string | null;
  qualityMetrics: QualityMetrics | null;
}

const TwilioContext = createContext<TwilioContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────
export function TwilioProvider({ children }: { children: ReactNode }) {
  const { user: authUser } = useAuth();
  const deviceRef = useRef<Device | null>(null);
  const callerNumberRef = useRef<string>('');

  // Timers
  const primaryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrored duration for use inside event listeners (state reads go stale there)
  const primaryDurationRef = useRef(0);
  // Metadata of the current/last call for auto-logging on disconnect.
  // dial() sets direction 'outbound'; answerIncoming() sets 'inbound'.
  // CampaignDialerPage passes { autoLog: false } and logs its own lead-aware call.
  const callMetaRef = useRef<{ direction: 'outbound' | 'inbound'; to_number?: string; from_number?: string } | null>(null);

  // Connection
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [sipConfigured, setSipConfigured] = useState(false);

  // Primary call state
  const primaryCallRef = useRef<Call | null>(null);
  const [primaryCall, setPrimaryCall] = useState<Call | null>(null);
  const [primaryCallState, setPrimaryCallState] = useState<CallState>('idle');
  const [primaryCallDuration, setPrimaryCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isHeld, setIsHeld] = useState(false);

  // Incoming call state
  const incomingCallRef = useRef<Call | null>(null);
  // Ref mirror of incomingCallerNumber — the state read inside answerIncoming
  // would be stale under StrictMode double-mounts (same trap as user?.id).
  const incomingCallerNumberRef = useRef('');
  const [incomingCall, setIncomingCall] = useState<Call | null>(null);
  const [incomingCallerNumber, setIncomingCallerNumber] = useState('');
  const [incomingCallerName, setIncomingCallerName] = useState('');
  useEffect(() => { incomingCallerNumberRef.current = incomingCallerNumber; }, [incomingCallerNumber]);

  // Held call state (interface parity — limited support)
  const [heldCall, setHeldCall] = useState<Call | null>(null);
  const [heldCallDuration, _setHeldCallDuration] = useState(0);
  const [heldCallerNumber, _setHeldCallerNumber] = useState('');

  // Errors
  const [error, setError] = useState<string | null>(null);
  const [sipError, setSipError] = useState<string | null>(null);
  const [qualityMetrics] = useState<QualityMetrics | null>(null);

  // Navigation
  const [activeCallRoute, setActiveCallRoute] = useState<string | null>(null);
  const [activeCallNumber, setActiveCallNumber] = useState<string | null>(null);

  // ── Timer helpers ──────────────────────────────────────────────────
  const startPrimaryTimer = useCallback(() => {
    if (primaryTimerRef.current) clearInterval(primaryTimerRef.current);
    setPrimaryCallDuration(0);
    primaryDurationRef.current = 0;
    primaryTimerRef.current = setInterval(() => {
      setPrimaryCallDuration((prev) => {
        primaryDurationRef.current = prev + 1;
        return prev + 1;
      });
    }, 1000);
  }, []);

  const stopPrimaryTimer = useCallback(() => {
    if (primaryTimerRef.current) {
      clearInterval(primaryTimerRef.current);
      primaryTimerRef.current = null;
    }
  }, []);

  // ── Helper to attach Call event listeners ──────────────────────────
  const attachCallListeners = useCallback((call: Call) => {
    debugLog('[TwilioContext] Attaching listeners to call:', call.parameters);

    call.on('accept', () => {
      debugLog('[TwilioContext] Call accepted');
      primaryCallRef.current = call;
      setPrimaryCall(call);
      setPrimaryCallState('active');
      startPrimaryTimer();
      setSipError(null);
    });

    call.on('disconnect', () => {
      debugLog('[TwilioContext] Call disconnected');
      stopPrimaryTimer();
      primaryCallRef.current = null;
      setPrimaryCall(null);
      setPrimaryCallState('done');
      setIsMuted(false);
      setIsHeld(false);
      setActiveCallRoute(null);
      setActiveCallNumber(null);

      // Auto-log leadless calls (manual dialer / inbound). Campaign calls log
      // themselves with lead_id via CampaignDialerPage — do not double-log.
      const meta = callMetaRef.current;
      callMetaRef.current = null;
      const duration = primaryDurationRef.current;
      if (meta && duration > 0) {
        const payload = {
          lead_id: null,
          campaign_id: null,
          duration_seconds: duration,
          status: 'completed',
          disposition: meta.direction === 'inbound' ? 'inbound_call' : 'manual_call',
          notes: meta.direction === 'inbound' ? 'Inbound call' : 'Manual out-of-band call',
          provider: 'twilio' as const,
          direction: meta.direction,
          to_number: meta.to_number || null,
          from_number: meta.from_number || null,
        };
        debugLog('[TwilioContext] Auto-logging call:', payload);
        callsApi.log(payload).catch((err) => console.error('[TwilioContext] Auto-log failed:', err));
      }
    });

    call.on('cancel', () => {
      debugLog('[TwilioContext] Call cancelled');
      stopPrimaryTimer();
      primaryCallRef.current = null;
      setPrimaryCall(null);
      setPrimaryCallState('done');
      setIsMuted(false);
      setIsHeld(false);
      setActiveCallRoute(null);
      setActiveCallNumber(null);
    });

    call.on('reject', () => {
      debugLog('[TwilioContext] Call rejected');
      stopPrimaryTimer();
      primaryCallRef.current = null;
      setPrimaryCall(null);
      setPrimaryCallState('done');
      setIsMuted(false);
      setActiveCallRoute(null);
      setActiveCallNumber(null);
    });

    call.on('error', (err: any) => {
      console.error('[TwilioContext] Call error:', err);
      setSipError(`Call error: ${err?.message || 'Unknown error'}`);
    });

    // Ringing event
    call.on('ringing', () => {
      debugLog('[TwilioContext] Call ringing');
      setPrimaryCallState('ringing');
    });

    // Track connection state changes for debugging
    call.on('stateChanged', (state: string) => {
      debugLog('[TwilioContext] Call state changed to:', state);
    });
  }, [startPrimaryTimer, stopPrimaryTimer]);

  // ── Connect to Twilio ──────────────────────────────────────────────
  const initConnection = useCallback(async () => {
    if (deviceRef.current) {
      try { deviceRef.current.destroy(); } catch { /* noop */ }
    }

    setConnectionStatus('connecting');
    setError(null);

    try {
      // Check if Twilio is configured
      const settingsRes = await settingsApi.get();
      const settings = settingsRes.data;

      if (!settings?.twilio_account_sid || !settings?.twilio_api_key) {
        setSipConfigured(false);
        setConnectionStatus('disconnected');
        // Surface WHY instead of hanging on "Connecting" forever
        if (!settings?.twilio_account_sid) {
          setError('Twilio account not connected. Open Connectors and save your Account SID + Auth Token.');
        } else {
          setError(
            'Twilio voice credentials missing. Open Connectors > Twilio and save the API Key SID, API Secret, TwiML App SID and Caller Number — the account connection alone cannot place calls.'
          );
        }
        return;
      }

      setSipConfigured(true);
      if (settings.twilio_caller_number) {
        callerNumberRef.current = settings.twilio_caller_number;
      }

      // Fetch Access Token from our backend
      const tokenRes = await twilioApi.getToken();
      if (!tokenRes.data?.token) {
        throw new Error('Failed to get Twilio token');
      }

      debugLog('[TwilioContext] Creating Device with token');
      // Forward SDK internal logs to the diag sink — the connect failure path
      // (mic acquisition, invite publish) only shows up in SDK debug logs.
      loglevel.setLevel(loglevel.levels.DEBUG);
      const origFactory = loglevel.methodFactory;
      loglevel.methodFactory = (methodName, level, loggerName) => {
        const raw = origFactory(methodName, level, loggerName);
        return (...args: any[]) => {
          const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) || String(a))).join(' ');
          if (methodName === 'warn' || methodName === 'error') {
            diag(`sdk.${methodName}`, line.slice(0, 400));
          }
          raw(...args);
        };
      };
      loglevel.setLevel(loglevel.levels.DEBUG);
      // Telemetry sink: post SDK lifecycle events to the server so stuck calls
      // are diagnosable from logs alone (his browser console is invisible to us).
      // diag is module-scoped (see top of file).
      window.addEventListener('error', (e) => diag('window.onerror', String(e.message).slice(0, 200)));
      diag('bundle.version', 'diag5-beaconed-sdk');

      // Enumerate mics once so we can hand Twilio a verified-working device.
      // Root cause of the silent dial failure: Twilio's openDefaultDeviceWithConstraints()
      // fails on stale/default mic selection (device ID drift after hotplug, exclusive
      // use, etc.) and disconnects without surfacing the error. Passing an explicit
      // deviceId that we just proven openable avoids the whole failure path.
      try {
        const probeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        preferredMicId = probeStream.getAudioTracks()[0]?.getSettings?.().deviceId;
        probeStream.getTracks().forEach((t) => t.stop());
      } catch (micErr: any) {
        console.error('[TwilioContext] Microphone probe failed:', micErr);
        setError(
          'Microphone blocked. Click the icon at the left of the address bar, set Microphone to Allow, then reload and dial again.'
        );
        return;
      }

      const device = new Device(tokenRes.data.token, {
        logLevel: 1, // DEBUG
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });

      // Device events
      device.on('registered', () => {
        debugLog('[TwilioContext] Device registered');
        diag('device.registered');
        setConnectionStatus('registered');
        setError(null);
      });

      device.on('error', (err: any) => {
        console.error('[TwilioContext] Device error:', err);
        diag('device.error', `${err?.name || ''}: ${err?.message || 'unknown'}${err?.causedBy ? ` causedBy=${err.causedBy}` : ''}`);
        setError(`Twilio error: ${err?.message || 'Unknown error'}`);
      });

      device.on('incoming', (call: Call) => {
        debugLog('[TwilioContext] Incoming call:', call.parameters);
        incomingCallRef.current = call;
        setIncomingCall(call);
        setIncomingCallerNumber(call.parameters?.From || 'Unknown');
        incomingCallerNumberRef.current = call.parameters?.From || 'Unknown';
        setIncomingCallerName(call.parameters?.FromCity || '');

        // Listen for cancel/reject on incoming call
        call.on('cancel', () => {
          incomingCallRef.current = null;
          setIncomingCall(null);
          setIncomingCallerNumber('');
          setIncomingCallerName('');
        });

        call.on('reject', () => {
          incomingCallRef.current = null;
          setIncomingCall(null);
          setIncomingCallerNumber('');
          setIncomingCallerName('');
        });
      });

      device.on('tokenWillExpire', async () => {
        debugLog('[TwilioContext] Token expiring, refreshing...');
        try {
          const refreshRes = await twilioApi.getToken();
          if (refreshRes.data?.token) {
            device.updateToken(refreshRes.data.token);
          }
        } catch (err) {
          console.error('[TwilioContext] Failed to refresh token:', err);
        }
      });

      await device.register();
      deviceRef.current = device;
      (window as any).__scDevice = device;
      (window as any).__scDeviceTag = (Device as any).__scModuleTag;

      debugLog('[TwilioContext] Device connected and registered');
      diag('device.register.done');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to initialize Twilio';
      try {
        fetch('/api/diag/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'device.register.fail', detail: message.slice(0, 400) }),
        }).catch(() => {});
      } catch { /* noop */ }
      setError(message);
      setConnectionStatus('disconnected');
      console.error('[TwilioContext] Init error:', err);
    }
  }, []);

  const disconnect = useCallback(() => {
    stopPrimaryTimer();
    if (deviceRef.current) {
      try { deviceRef.current.destroy(); } catch { /* noop */ }
      deviceRef.current = null;
    }
    setConnectionStatus('disconnected');
    setPrimaryCallState('idle');
    setPrimaryCall(null);
    primaryCallRef.current = null;
    setActiveCallNumber(null);
    setIncomingCall(null);
    incomingCallRef.current = null;
    setHeldCall(null);
    setSipError(null);
    setIsMuted(false);
    setIsHeld(false);
  }, [stopPrimaryTimer]);

  // ── Call actions ───────────────────────────────────────────────────
  const dial = useCallback(
    async (destinationNumber: string, callerNumber?: string, opts?: { autoLog?: boolean }) => {
      // Prefer the live device handle: React StrictMode double-mounts providers,
      // leaving stale deviceRefs bound to destroyed devices whose connect()
      // silently no-ops. window.__scDevice always holds the latest registered one.
      const liveDevice: any = (window as any).__scDevice;
      const device = (liveDevice && typeof (liveDevice as any).state === 'function' && (liveDevice as any).state() === 'registered')
        ? liveDevice
        : deviceRef.current;
      if (!device) { setError('Twilio device not initialized.'); return; }
      if (connectionStatus !== 'registered') { setError('Twilio not registered yet.'); return; }
      if (primaryCallRef.current) { setError('A call is already in progress.'); return; }

      const resolvedCallerNumber = callerNumber || callerNumberRef.current || '';

      // Validate caller number is present - Twilio requires a verified callerId for outbound calls
      if (!resolvedCallerNumber || !/^\+?\d{10,15}$/.test(resolvedCallerNumber.replace(/[\s\-()]/g, ''))) {
        console.error('[TwilioContext] Invalid or missing caller number:', resolvedCallerNumber);
        setError('Caller ID not configured. Please set a verified phone number in Connectors > Twilio.');
        return;
      }

      debugLog('[TwilioContext] dial():', { destinationNumber, resolvedCallerNumber });
      // Call metadata for auto-logging on disconnect (unless the caller logs itself,
      // e.g. CampaignDialerPage which logs with lead_id for the attempt counter).
      callMetaRef.current = opts?.autoLog === false
        ? null
        : { direction: 'outbound', to_number: destinationNumber };
      primaryDurationRef.current = 0;
      try {
        fetch('/api/diag/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'dial.start', detail: `to=${destinationNumber} from=${resolvedCallerNumber}` }),
        }).catch(() => {});
      } catch { /* noop */ }

      setError(null);
      setSipError(null);
      setPrimaryCallState('trying');
      setActiveCallNumber(destinationNumber);

      try {
        const devAny: any = device;
        const sameAsLive = !!(device && (window as any).__scDevice && device === (window as any).__scDevice);
        const st = typeof devAny?.state === 'function' ? devAny.state() : (devAny?._state ?? 'n/a');
        fetch('/api/diag/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'dial.invoking_connect', detail: `deviceExists=${!!device} status=${connectionStatus} sameAsLive=${sameAsLive} state=${st}` }),
        }).catch(() => {});
      } catch (e: any) {
        fetch('/api/diag/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'dial.invoking_connect.ERR', detail: String(e?.message || e).slice(0, 150) }) }).catch(() => {});
      }

      // Mic is already verified at device init (probe + getInputStream), so no
      // per-dial pre-flight needed here — Twilio gets our proven mic explicitly.

      // Timeout guard: if the connect never completes (mic blocked, Twilio edge
      // unreachable), fail loudly after 15s instead of hanging on "Connecting Call".
      let connectSettled = false;
      const connectTimer = setTimeout(() => {
        if (!connectSettled) {
          try {
            fetch('/api/diag/event', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ event: 'connect.timeout.15s', detail: `to=${destinationNumber} state=deviceRegistered=${connectionStatus}` }),
            }).catch(() => {});
          } catch { /* noop */ }
          setError(
            'Call could not start after 15s. Most common cause: microphone blocked for this site — click the icon in the address bar and Allow, then reload. If mic is allowed, your network may be blocking Twilio voice (try a phone hotspot).'
          );
          setPrimaryCallState('idle');
          setActiveCallNumber(null);
        }
      }, 15000);

      try {
        fetch('/api/diag/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'dial.calling_connect', detail: `line-reached deviceSame=${device === (window as any).__scDevice}` }),
        }).catch(() => {});
      } catch { /* noop */ }
      let connectPromise: Promise<any>;
      try {
        connectPromise = device.connect({
          params: {
            To: destinationNumber,
            From: resolvedCallerNumber,
            Rep: authUser?.id || '',
          },
          // Per-call mic: re-open the proven mic each dial (fresh tracks per call).
          getInputStream: preferredMicId
            ? async () =>
                navigator.mediaDevices.getUserMedia({
                  audio: { deviceId: { exact: preferredMicId } },
                })
            : undefined,
        } as any);
        try {
          fetch('/api/diag/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'dial.connect_returned', detail: `promiseType=${typeof connectPromise?.then}` }),
          }).catch(() => {});
        } catch { /* noop */ }
      } catch (syncErr: any) {
        connectSettled = true;
        clearTimeout(connectTimer);
        try {
          fetch('/api/diag/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'dial.connect_SYNC_THROW', detail: String(syncErr?.message || syncErr).slice(0, 250) }),
          }).catch(() => {});
        } catch { /* noop */ }
        setError(`Dial failed: ${syncErr?.message || 'unknown'}`);
        setPrimaryCallState('idle');
        setActiveCallNumber(null);
        return;
      }
      connectPromise.then((call) => {
        connectSettled = true;
        clearTimeout(connectTimer);
        debugLog('[TwilioContext] device.connect() succeeded, call parameters:', call.parameters);
        diag('device.connect.resolved', JSON.stringify(call.parameters || {}).slice(0, 300));
        // attach error listener IMMEDIATELY — errors can fire before 'accept'
        // (e.g. mic acquisition failure inside the SDK) and were being missed.
        call.on('error', (e: any) =>
          diag('call.error.early', `${e?.name || ''}: ${e?.message || 'unknown'} ${e?.causedBy ? JSON.stringify(e.causedBy).slice(0, 200) : ''}`)
        );
        primaryCallRef.current = call;
        setPrimaryCall(call);
        attachCallListeners(call);
        call.on('accept', () => diag('call.accepted'));
        call.on('disconnect', () => diag('call.disconnected', call.parameters?.CallSid));
      }).catch((err: any) => {
        connectSettled = true;
        clearTimeout(connectTimer);
        console.error('[TwilioContext] Connect failed:', err);
        diag('device.connect.rejected', String(err?.message || err).slice(0, 300));
        setError(`Failed to dial: ${err?.message || 'Unknown error'}`);
        setPrimaryCallState('idle');
        setActiveCallNumber(null);
      });
    },
    [connectionStatus, attachCallListeners]
  );

  const hangup = useCallback(() => {
    // Robust hangup: the UI may hold a stale context instance, so also try the
    // live device's active call. Report what actually happened to the diag sink.
    const candidates = [
      primaryCallRef.current,
      (window as any).__scDevice?._activeCall || null,
    ].filter(Boolean);
    if (candidates.length) {
      const seen = new Set<any>();
      for (const c of candidates) {
        if (seen.has(c)) continue;
        seen.add(c);
        try {
          c.disconnect();
          try {
            fetch('/api/diag/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'hangup.disconnect_called', detail: String(c.parameters?.CallSid || 'no-sid') }) }).catch(() => {});
          } catch { /* noop */ }
        } catch (e: any) {
          try {
            fetch('/api/diag/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'hangup.disconnect_ERROR', detail: String(e?.message || e) }) }).catch(() => {});
          } catch { /* noop */ }
        }
      }
    } else {
      try {
        fetch('/api/diag/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'hangup.no_call_object', detail: 'primaryCallRef and live _activeCall both empty' }) }).catch(() => {});
      } catch { /* noop */ }
      // No disconnect event will fire — drop any stale call meta so it can't
      // leak into the next call's auto-log.
      callMetaRef.current = null;
    }
    stopPrimaryTimer();
    setPrimaryCallState('done');
    primaryCallRef.current = null;
    setPrimaryCall(null);
    setIsMuted(false);
    setIsHeld(false);
    setActiveCallRoute(null);
    setActiveCallNumber(null);
  }, [stopPrimaryTimer]);

  const answerIncoming = useCallback(() => {
    if (incomingCallRef.current) {
      incomingCallRef.current.accept();
      primaryCallRef.current = incomingCallRef.current;
      setPrimaryCall(incomingCallRef.current);
      setPrimaryCallState('active');
      // From is usually "client:user_<id>" for browser clients or an E.164 for
      // real phones — keep the raw value; the server filters non-digit ones out
      // of the Pipedrive push.
      callMetaRef.current = {
        direction: 'inbound',
        from_number: incomingCallerNumberRef.current || incomingCallRef.current.parameters?.From || '',
      };
      primaryDurationRef.current = 0;
      startPrimaryTimer();
      setActiveCallNumber(incomingCallerNumber || null);
      attachCallListeners(incomingCallRef.current);

      // Clear incoming state
      incomingCallRef.current = null;
      setIncomingCall(null);
      setIncomingCallerNumber('');
      setIncomingCallerName('');
    }
  }, [startPrimaryTimer, attachCallListeners, incomingCallerNumber]);

  const rejectIncoming = useCallback(() => {
    if (incomingCallRef.current) {
      incomingCallRef.current.reject();
      incomingCallRef.current = null;
      setIncomingCall(null);
      setIncomingCallerNumber('');
      setIncomingCallerName('');
    }
  }, []);

  // Hold is limited in Twilio Browser SDK — stub for interface parity
  const holdAndAnswer = useCallback(() => {
    console.warn('[TwilioContext] holdAndAnswer not fully supported in Twilio browser SDK');
  }, []);

  const hangupAndResume = useCallback(() => {
    console.warn('[TwilioContext] hangupAndResume not fully supported in Twilio browser SDK');
  }, []);

  const toggleMute = useCallback(() => {
    if (primaryCallRef.current) {
      const newMuted = !primaryCallRef.current.isMuted();
      primaryCallRef.current.mute(newMuted);
      setIsMuted(newMuted);
    }
  }, []);

  const toggleHold = useCallback(() => {
    console.warn('[TwilioContext] Hold is not directly supported in Twilio browser SDK');
    // In real implementation, this would require TwiML conference or REST API
  }, []);

  const sendDTMF = useCallback((digit: string) => {
    if (primaryCallRef.current) {
      primaryCallRef.current.sendDigits(digit);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPrimaryTimer();
      if (deviceRef.current) {
        try { deviceRef.current.destroy(); } catch { /* noop */ }
      }
    };
  }, [stopPrimaryTimer]);

  const value: TwilioContextValue = {
    connectionStatus,
    initConnection,
    disconnect,
    sipConfigured,

    primaryCall,
    primaryCallState,
    primaryCallDuration,
    isMuted,
    isHeld,

    incomingCall,
    incomingCallerNumber,
    incomingCallerName,

    heldCall,
    heldCallDuration,
    heldCallerNumber,

    dial,
    hangup,
    answerIncoming,
    rejectIncoming,
    holdAndAnswer,
    hangupAndResume,
    toggleMute,
    toggleHold,
    sendDTMF,

    error,
    sipError,
    qualityMetrics,

    activeCallRoute,
    setActiveCallRoute,
    activeCallNumber,
  };

  return (
    <TwilioContext.Provider value={value}>
      {children}
    </TwilioContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────
export function useTwilioContext(): TwilioContextValue {
  const ctx = useContext(TwilioContext);
  if (!ctx) {
    throw new Error('useTwilioContext must be used within a TwilioProvider');
  }
  return ctx;
}

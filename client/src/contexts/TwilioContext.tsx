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
  console.log('[TwilioContext] Device.connect wrapped for diagnostics');
} catch (wrapErr) {
  console.error('[TwilioContext] Failed to wrap Device.connect:', wrapErr);
}
import { twilioApi, settingsApi } from '@/lib/api';
import { useAuth } from './AuthContext';

import type { ConnectionStatus, CallState, QualityMetrics } from './TelnyxContext';

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
  dial: (destinationNumber: string, callerNumber?: string) => void;
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
  const [incomingCall, setIncomingCall] = useState<Call | null>(null);
  const [incomingCallerNumber, setIncomingCallerNumber] = useState('');
  const [incomingCallerName, setIncomingCallerName] = useState('');

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

  // ── Timer helpers ──────────────────────────────────────────────────
  const startPrimaryTimer = useCallback(() => {
    if (primaryTimerRef.current) clearInterval(primaryTimerRef.current);
    setPrimaryCallDuration(0);
    primaryTimerRef.current = setInterval(() => {
      setPrimaryCallDuration((prev) => prev + 1);
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
    console.log('[TwilioContext] Attaching listeners to call:', call.parameters);

    call.on('accept', () => {
      console.log('[TwilioContext] Call accepted');
      primaryCallRef.current = call;
      setPrimaryCall(call);
      setPrimaryCallState('active');
      startPrimaryTimer();
      setSipError(null);
    });

    call.on('disconnect', () => {
      console.log('[TwilioContext] Call disconnected');
      stopPrimaryTimer();
      primaryCallRef.current = null;
      setPrimaryCall(null);
      setPrimaryCallState('done');
      setIsMuted(false);
      setIsHeld(false);
      setActiveCallRoute(null);
    });

    call.on('cancel', () => {
      console.log('[TwilioContext] Call cancelled');
      stopPrimaryTimer();
      primaryCallRef.current = null;
      setPrimaryCall(null);
      setPrimaryCallState('done');
      setIsMuted(false);
      setIsHeld(false);
      setActiveCallRoute(null);
    });

    call.on('reject', () => {
      console.log('[TwilioContext] Call rejected');
      stopPrimaryTimer();
      primaryCallRef.current = null;
      setPrimaryCall(null);
      setPrimaryCallState('done');
      setIsMuted(false);
      setActiveCallRoute(null);
    });

    call.on('error', (err: any) => {
      console.error('[TwilioContext] Call error:', err);
      setSipError(`Call error: ${err?.message || 'Unknown error'}`);
    });

    // Ringing event
    call.on('ringing', () => {
      console.log('[TwilioContext] Call ringing');
      setPrimaryCallState('ringing');
    });

    // Track connection state changes for debugging
    call.on('stateChanged', (state: string) => {
      console.log('[TwilioContext] Call state changed to:', state);
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

      console.log('[TwilioContext] Creating Device with token');
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
      // can be diagnosed from the diag timeline instead of guesswork.
      const diag = (event: string, detail?: string) => {
        try {
          fetch('/api/diag/event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, detail }),
          }).catch(() => {});
        } catch { /* noop */ }
      };

      diag('bundle.version', 'diag5-beaconed-sdk');

      const device = new Device(tokenRes.data.token, {
        codecPreferences: ['opus', 'pcmu'] as any,
      });
      // Explicit proven mic: enumerate audioinput devices at init and pick a real
      // one (not 'default'/'communications') so the SDK never stalls acquiring
      // an unavailable default device.
      let provenDeviceId: string | undefined;
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const mics = devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        if (mics.length) {
          provenDeviceId = mics[0].deviceId;
          console.log('[TwilioContext] Proven mic deviceId:', provenDeviceId);
        }
      } catch (e) {
        console.warn('[TwilioContext] Mic enumeration failed:', e);
      }
      try {
        await device.updateOptions({ ...(provenDeviceId ? { audioInputDevices: [provenDeviceId as any] } : {}) } as any);
      } catch (e) {
        console.warn('[TwilioContext] updateOptions with mic failed:', e);
      }

      device.on('registered', () => {
        console.log('[TwilioContext] Device registered');
        diag('device.registered', '');
      });
      device.on('unregistered', () => {
        console.log('[TwilioContext] Device unregistered');
        setConnectionStatus('registered');
      });
      device.on('error', (e: any) => {
        console.error('[TwilioContext] Device error:', e);
        diag('device.error', `${e?.name || ''}: ${e?.message || 'unknown'}`);
      });

      device.audio?.on('deviceChange', () => {
        console.log('[TwilioContext] Audio device changed');
      });

      console.log('[TwilioContext] Registering device...');
      await device.register();
      deviceRef.current = device;
      (window as any).__scDevice = device;
      (window as any).__scDeviceTag = (Device as any).__scModuleTag;

      setConnectionStatus('registered');
      console.log('[TwilioContext] Device connected and registered');
      diag('device.register.done', '');
    } catch (err: any) {
      console.error('[TwilioContext] Failed to initialize Twilio:', err);
      diag('device.register.failed', String(err?.message || err).slice(0, 300));
      setConnectionStatus('disconnected');
      setError(`Twilio connection failed: ${err?.message || 'Unknown error'}`);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (deviceRef.current) {
      try { deviceRef.current.destroy(); } catch { /* noop */ }
      deviceRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, []);

  const dial = useCallback(
    async (destinationNumber: string, callerNumber?: string) => {
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

      console.log('[TwilioContext] dial():', { destinationNumber, resolvedCallerNumber });
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
        });
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
        return;
      }
      connectPromise.then((call) => {
        connectSettled = true;
        clearTimeout(connectTimer);
        console.log('[TwilioContext] device.connect() succeeded, call parameters:', call.parameters);
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
        console.error('[TwilioContext] device.connect() rejected:', err);
        diag('device.connect.rejected', String(err?.message || err).slice(0, 300));
        setPrimaryCallState('idle');
        setError(`Dial failed: ${err?.message || 'Unknown error'}`);
      });
    },
    [connectionStatus, attachCallListeners, authUser]
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
    }
    stopPrimaryTimer();
    setPrimaryCallState('done');
    primaryCallRef.current = null;
    setPrimaryCall(null);
    setIsMuted(false);
    setIsHeld(false);
    setActiveCallRoute(null);
  }, [stopPrimaryTimer]);

  const answerIncoming = useCallback(() => {
    if (incomingCallRef.current) {
      incomingCallRef.current.accept();
      primaryCallRef.current = incomingCallRef.current;
      setPrimaryCall(incomingCallRef.current);
      setPrimaryCallState('active');
      startPrimaryTimer();
      attachCallListeners(incomingCallRef.current);

      // Clear incoming state
      incomingCallRef.current = null;
      setIncomingCall(null);
      setIncomingCallerNumber('');
      setIncomingCallerName('');
    }
  }, [startPrimaryTimer, attachCallListeners]);

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

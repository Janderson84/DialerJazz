# Implementation plan: click-to-call from Pipedrive + call logging to Pipedrive

Repo: `Janderson84/DialerJazz` (InsForge backend + Express/TS `server/` + React `client/`).

## Feature 1 — tel: click-to-call on /dialer

**Goal restated:** a Pipedrive phone-number link opens `/dialer?tel=<number>`, and ManualDialerPage prefills the softphone input with that number (one click to dial; not auto-dial).

### Files

1. **`client/src/pages/ManualDialerPage.tsx`**
   - New `useEffect` (run once, guarded by a module-level or ref `registeredRef`):
     ```ts
     // Protocol registration (Chrome/Edge; no-op elsewhere)
     if ('registerProtocolHandler' in navigator) {
       try {
         navigator.registerProtocolHandler?.('tel', `${window.location.origin}/dialer?tel=%s`, 'DialerJazz');
       } catch { /* unsupported or user denied — fine */ }
     }
     ```
   - New `useEffect` reading the param via `useSearchParams` (react-router):
     - `const tel = searchParams.get('tel')` — strip a leading `tel:` scheme if present, strip whitespace, keep digits and leading `+` (`normalizePhone(raw)` helper in this file).
     - If non-empty: `setNumberInput(normalized)` + focus the input, then `setSearchParams({}, { replace: true })` so refresh/back doesn't redial or re-prefill.
   - `handleDial` unchanged. Keep a `dialedNumberRef` of the number passed to `voice.dial()` for logging (see Feature 2 — input can be edited/cleared mid-call).
   - Remove the `callsApi.log(...)` block from `handleHangUp` — logging moves to TwilioContext (dedupe, see below).

2. **`client/src/lib/api.ts`** — extend `callsApi.log` payload type only:
   ```ts
   { ...existing, direction?: 'outbound' | 'inbound', to_number?: string | null, from_number?: string | null }
   ```

### Behavior / edge cases
- Handler registration is browser-permission gated; silently skip if unsupported (Safari/Firefox).
- `tel:` values arrive URL-encoded (`tel:%2B1217...`) — always `decodeURIComponent` before normalizing.
- No `tel` param → page behaves exactly as today. Pre-fill only; user clicks Dial (prevents accidental calls from a misclick in Pipedrive).
- Non-North-American numbers: digits + `+` pass through; don't force E.164 in the client.

## Feature 2 — call logging to Pipedrive

**Goal restated:** every manual call (outbound from the dialer without a campaign lead, and inbound answered calls) is stored in `call_logs` with correct direction, and best-effort pushed to Pipedrive by resolving the phone → PD person/deal server-side.

### Server files

1. **`server/src/routes/pipedrive.ts`** (additions only; reuse existing helpers)
   - Extract note-building from `POST /log-call` into a shared helper so both paths emit the same format:
     ```ts
     export async function pushPdCallActivity(
       token: string,
       opts: { deal_id?: number | null; person_id?: number | null; direction: 'outbound' | 'inbound';
               disposition: string; duration_secs: number; notes?: string; rep_name?: string; rep_email?: string }
     ): Promise<{ activity_id: number | null }>
     ```
     `POST /log-call` becomes a thin wrapper over it (contract unchanged).
   - New resolver:
     ```ts
     export async function resolvePdByPhone(token: string, phone: string): Promise<
       { matched: true; person_id: number; deal_id: number | null; duplicates: number[]; person_name: string }
       | { matched: false } >
     ```
     - Look up person: `GET /persons/find?term=<phone>&search_by_phone=1` (v1 endpoint). If it errors/empty, fall back to a plain `GET /persons?limit=100` filter on normalized digits (last 10 digits comparison) — keep the fallback cheap.
     - Deals for person: `GET /deals?person_id=<id>&status=open`.
     - **Duplicate deals:** pick the open deal with the most recent `update_time`; if more than one open deal, record the others in the activity note (`Other open deals: 123, 456`) and return them in `duplicates`. If zero open deals, still match the person and log the activity with `person_id` only (no `deal_id`).
   - No new routes strictly required. Optional (small win, do if cheap): `GET /lookup?phone=` returning the resolver output so the dialer can show "Calling: Person — Deal Title" pre-dial.

2. **`server/src/routes/calls.ts`** (`POST /log` only)
   - Extend the zod schema:
     ```ts
     direction: z.enum(['outbound', 'inbound']).default('outbound'),
     to_number: z.string().max(40).optional().nullable(),
     from_number: z.string().max(40).optional().nullable(),
     ```
   - Insert uses `validated.direction`, `validated.to_number`, `validated.from_number` (columns exist; insert was just never setting them).
   - After the insert, when `!validated.lead_id && (to_number || from_number)` — i.e. the manual/inbound path only — do a **best-effort, non-fatal** Pipedrive push:
     ```ts
     let pdResult: unknown = null;
     if (!validated.lead_id && (validated.to_number || validated.from_number)) {
       try {
         const phone = validated.direction === 'inbound' ? validated.from_number : validated.to_number;
         const token = await getPipedriveToken(req);        // throws ApiError 400 'pd_no_token' if unset
         const pdUserId = await resolvePdUserId(req, token); // reuse existing, unchanged
         const match = await resolvePdByPhone(token, phone);
         if (match.matched) { pdResult = await pushPdCallActivity(token, { ...match, direction: validated.direction, ... }); }
         else pdResult = { matched: false };
       } catch (e) { console.warn('[calls/log] pipedrive push skipped:', (e as Error).message); pdResult = { skipped: true }; }
     }
     ```
   - Response: `{ data: logData, pipedrive: pdResult }` — the call log is **always** 200 regardless of Pipedrive outcome.
   - The existing `lead_id + campaign_id` branch (attempt counter, campaign recount) is untouched.

3. **`server/src/middleware/auth.ts`** — no change; `/log` is already `requireAuth` and `req.user.token` works with `getInsforgeClient` the same way pipedrive.ts uses it.

### Client files

4. **`client/src/contexts/TwilioContext.tsx`** — single place for call logging (prevents the ManualDialerPage/TwilioContext double-log):
   - Add a ref: `const callMetaRef = useRef<{ direction: 'outbound' | 'inbound'; to_number?: string; from_number?: string } | null>(null);`
   - Set it in `dial(destinationNumber, ...)`: `callMetaRef.current = { direction: 'outbound', to_number: destinationNumber }`.
   - Set it in `answerIncoming()`: `callMetaRef.current = { direction: 'inbound', from_number: incomingCallerNumber || incomingCallRef.current?.parameters?.From }`.
   - In the `disconnect` listener of `attachCallListeners`: if `callMetaRef.current` and the answered call had a positive duration, fire-and-forget:
     ```ts
     callsApi.log({ lead_id: null, campaign_id: null, duration_seconds: primaryCallDuration,
       status: 'completed', disposition: callMetaRef.current.direction === 'inbound' ? 'inbound_call' : 'manual_call',
       direction: callMetaRef.current.direction, to_number, from_number, provider: 'twilio' }).catch(console.error);
     callMetaRef.current = null;
     ```
     (Read duration via a ref or capture it in the listener closure — `primaryCallDuration` from a hook is stale in callbacks; mirror it to a ref alongside the existing timer.)
   - `device.on('incoming')` handler: unchanged except it already captures `From` — do **not** log on `incoming`/`cancel`/`reject` (only answered calls get logged).
   - `hangup()` clears nothing extra — the disconnect event handles it. Clear `callMetaRef` in `hangup`'s fallback path too (the "no call object" branch) to avoid a stale meta leaking into the next call.

### Edge cases (both features)

| Case | Behavior |
|---|---|
| No Pipedrive token configured | `/log` returns 200 with `pipedrive: { skipped: true }` (the `getPipedriveToken` 400 is caught server-side). Call log still saved. Never blocks dialing. |
| No PD match for the phone | `pipedrive: { matched: false }` — no activity created. |
| Duplicate open deals on the person | Activity goes on most-recently-updated open deal; others listed in the note and in `duplicates[]`. |
| PD API error / 502 | Caught, warn-logged, `pipedrive: { skipped: true }`; HTTP 200. |
| Inbound `From` is `client:...` / `unknown` / no digits | Skip PD push (digits check on the number); still log to `call_logs` with direction inbound. |
| Rejected/cancelled/missed inbound | No log at all (matches current behavior; add missed-call logging later if James asks). |
| Multiple Pipedrive users / attribution | Reuse `resolvePdUserId` unchanged — email match, cached in `team_members.pd_user_id`, master override via `/team-mapping`. No per-rep tokens. |
| `tel` param malformed (`tel:`-prefixed, spaces, dashes) | Normalized to digits + leading `+`; empty after normalization → ignore param. |
| Protocol handler unsupported / denied | No-op; the page is still fully usable manually. |
| Double logging | ManualDialerPage's `handleHangUp` log block is removed; TwilioContext is the single writer. Verify no other component calls `callsApi.log` without a lead (grep `callsApi.log` — currently only ManualDialerPage). |

## What NOT to change

- **`server/src/routes/twilio.ts`** — `/api/twilio/voice`, `/api/twilio/inbound?rep=`, and the self-dial-loop guard. These are the proven call-routing paths (the Oct 1 call-storm fix); no touch.
- **TwiML App / number webhook wiring** (voice_url = `/api/twilio/voice`, rep/master numbers on `/inbound`). Nothing in this plan needs a webhook change.
- **Composio-based flows** — Composio credentials are agent-side only and can't be exported; the app's Pipedrive token stays in `user_settings.pipedrive_api_key` via the Connectors page. Don't try to source the token anywhere else.
- **`POST /api/pipedrive/log-call` contract** — becomes a wrapper over `pushPdCallActivity` but keeps the same request/response shape for the campaign path.
- **`resolvePdUserId`** — reuse as-is (including its caching).
- **`POST /api/pipedrive/import`** and the lead-upsert dedupe logic.
- **`calls.ts` campaign branch** — `increment_lead_attempts` / `increment_campaign_calls` semantics stay exactly as shipped (attempt counter + evergreen Retries depend on them).
- **VoiceContext / TelnyxContext interface** — TwilioContext changes are internal; no signature changes to the shared context value.

## Build/test notes

- `server/`: `npx tsc --noEmit` + existing vitest (`server/src/routes/__tests__/`); add a small test for the zod schema accepting direction/from_number and for the non-fatal PD-push catch.
- `client/`: remember the Vite traps — `rm -rf client/node_modules/.vite` and restart Vite after SDK-adjacent edits; HMR keeps stale module instances, use `window.__scDevice` for live verification.
- E2E sanity with the Playwright fake-media loop (`/root/pw-*.py`): dial a test number from `/dialer?tel=+1217...`, confirm the input prefill, one call_logs row with `direction=outbound` + `to_number`, and `pipedrive` in the response; then call the master number in and confirm one `direction=inbound` row.
- PD push is untestable live until James pastes his API token in Connectors (still pending as of the wiki) — ship with the non-fatal path verified against `pd_no_token`.

## Sequencing

1. `calls.ts` schema + insert + non-fatal push (server, independent).
2. `pipedrive.ts` shared helpers + resolver.
3. `TwilioContext` callMeta + disconnect logging; delete ManualDialerPage's log.
4. ManualDialerPage tel-param prefill + protocol registration.
5. Tests + tsc + the Playwright loop above.

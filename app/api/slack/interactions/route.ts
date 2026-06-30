/**
 * MM Slack Interactions Router
 *
 * Sits in front of both Lightning McQueen (mm-google-ads-autopilot) and the
 * MM Meta Ads Autopilot (mm-meta-ads-autopilot). A single Slack app can only
 * have one interactivity Request URL, so this router inspects the action_id
 * and proxies the full payload to the correct downstream autopilot.
 *
 * Routing table
 * ─────────────────────────────────────────────────────────────────────────
 * Google Ads only:
 *   - intervene_action        (exact) — Intervene button on Google Ads approval cards
 *   - approve_group           (exact) — Approve-group button on Google Ads group cards
 *   - reject_group            (exact) — Reject-group button on Google Ads group cards
 *   - mm_campaign_approve_*   (prefix) — Campaign proposal approve buttons
 *   - mm_campaign_reject_*    (prefix) — Campaign proposal reject buttons
 *
 * Disambiguated by button value format (approve_action / reject_action):
 *   - Google Ads button value = plain UUID string (the auditLogId)
 *   - Meta Ads button value   = JSON object { approvalId } or { auditLogId }
 *   Routing inspects the button value and sends to the correct autopilot only.
 *   This prevents the "Couldn't find this proposal" thread reply that occurred
 *   when Meta Ads received Google Ads approval clicks it could never resolve.
 *
 * Both autopilots (fan-out — no button value to inspect):
 *   - view_submission         (type)  — Modal submissions from both apps
 *
 * No signature verification here — downstream autopilots verify via
 * x-router-secret header (HMAC can't be re-verified after a proxy hop).
 */

import { after } from 'next/server';

const GOOGLE_ADS_URL = 'https://mm-google-ads-autopilot.vercel.app/api/slack/interactions';
const META_ADS_URL = 'https://mm-meta-ads-autopilot.vercel.app/api/slack/interactions';

/**
 * Returns true when value is a plain UUID (Google Ads button format).
 * Google Ads sets button values to a raw auditLogId UUID string.
 * Meta Ads sets button values to a JSON object { approvalId } or { auditLogId }.
 */
function isGoogleAdsButtonValue(value: string): boolean {
  try {
    JSON.parse(value);
    return false; // Valid JSON → Meta Ads format
  } catch {
    return true; // Not JSON → plain UUID → Google Ads format
  }
}

export async function POST(req: Request) {
  const body = await req.text();

  // Parse the payload — Slack sends as application/x-www-form-urlencoded
  // with a `payload` field containing URL-encoded JSON.
  let actionId = '';
  let payloadType = '';
  let callbackId = '';
  let buttonValue = '';
  try {
    const params = new URLSearchParams(body);
    const payload = JSON.parse(params.get('payload') ?? '{}');
    payloadType = payload?.type ?? '';
    actionId = payload?.actions?.[0]?.action_id ?? '';
    callbackId = payload?.view?.callback_id ?? '';
    buttonValue = payload?.actions?.[0]?.value ?? '';
  } catch {
    console.warn('[router] failed to parse payload — returning 200 to Slack');
    return new Response('', { status: 200 });
  }

  // ── Routing table ─────────────────────────────────────────────────────────

  const targets = resolveTargets(actionId, payloadType, callbackId, buttonValue);

  // ── Respond 200 to Slack immediately (3-second rule), then proxy async ────

  if (targets.length > 0) {
    const capturedTargets = targets;
    const capturedBody = body;
    const capturedActionId = actionId || callbackId || payloadType;

    after(async () => {
      await Promise.all(
        capturedTargets.map(async (url) => {
          try {
            await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-slack-signature': req.headers.get('x-slack-signature') ?? '',
                'x-slack-request-timestamp': req.headers.get('x-slack-request-timestamp') ?? '',
                'x-router-secret': process.env.ROUTER_SECRET ?? '',
              },
              body: capturedBody,
            });
            console.log(`[router] ${capturedActionId} → ${url}`);
          } catch (err) {
            console.error(`[router] proxy failed → ${url}:`, err);
          }
        })
      );
    });
  } else {
    console.warn(`[router] unrouted payload: type="${payloadType}" action_id="${actionId}" callback_id="${callbackId}"`);
  }

  return new Response('', { status: 200 });
}

function resolveTargets(actionId: string, payloadType: string, callbackId: string, buttonValue: string): string[] {
  // Action_ids exclusive to Google Ads Autopilot (McQueen)
  const GOOGLE_ADS_ONLY: string[] = [
    'intervene_action',
    'approve_group',
    'reject_group',
  ];

  // Google Ads campaign builder uses dynamic action_ids with these prefixes
  if (actionId.startsWith('mm_campaign_approve_') || actionId.startsWith('mm_campaign_reject_')) {
    return [GOOGLE_ADS_URL];
  }

  if (GOOGLE_ADS_ONLY.includes(actionId)) {
    return [GOOGLE_ADS_URL];
  }

  // approve_action and reject_action are used by both autopilots, but their
  // button value formats differ. Route to the correct autopilot only — do NOT
  // fan-out to both. Fan-out caused the Meta Ads autopilot to reply "Couldn't
  // find this proposal" on every Google Ads approval card click.
  //
  // Google Ads: value = plain UUID string (the auditLogId)
  // Meta Ads:   value = JSON object { approvalId } or { auditLogId }
  if (actionId === 'approve_action' || actionId === 'reject_action') {
    if (buttonValue && isGoogleAdsButtonValue(buttonValue)) {
      return [GOOGLE_ADS_URL];
    }
    return [META_ADS_URL];
  }

  // view_submission payloads (modal submissions) have no actions[] array.
  // Route by callback_id instead — fan out to both autopilots so each
  // processes only the callback_ids it recognises. The empty-200 response
  // closes the modal on Slack's side.
  if (payloadType === 'view_submission') {
    if (callbackId) {
      return [GOOGLE_ADS_URL, META_ADS_URL];
    }
    return [];
  }

  // Unknown action_id — fan-out to both as a safe fallback
  if (actionId) {
    console.warn(`[router] unrecognised action_id "${actionId}" — fanning out to both`);
    return [GOOGLE_ADS_URL, META_ADS_URL];
  }

  return [];
}

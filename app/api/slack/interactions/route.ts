/**
 * MM Slack Interactions Router
 *
 * Sits in front of both Lightning McQueen (mm-google-ads-autopilot) and the
 * MM Meta Ads Autopilot (mm-meta-ads-autopilot). A single Slack app can only
 * have one interactivity Request URL, so this router inspects the action_id
 * and proxies the full payload to the correct downstream autopilot.
 *
 * Routing table (grepped from both repos 2026-06-09)
 * ───────────────────────────────────────────────────
 * Google Ads only:
 *   - intervene_action        (exact) — Intervene button on Google Ads approval cards
 *   - approve_group           (exact) — Approve-group button on Google Ads group cards
 *   - reject_group            (exact) — Reject-group button on Google Ads group cards
 *   - mm_campaign_approve_*   (prefix) — Campaign proposal approve buttons
 *   - mm_campaign_reject_*    (prefix) — Campaign proposal reject buttons
 *
 * Both autopilots (fan-out):
 *   - approve_action          (exact) — Both autopilots use this action_id
 *   - reject_action           (exact) — on their approval cards. Fan-out to
 *                                       both; each autopilot's DB race-guard
 *                                       ensures the action executes exactly
 *                                       once on the correct side.
 *   - view_submission         (type)  — Modal submissions; routed by callback_id (fan-out to both)
 *
 * No signature verification here — downstream autopilots verify via
 * x-router-secret header (HMAC can't be re-verified after a proxy hop).
 */

import { after } from 'next/server';

const GOOGLE_ADS_URL = 'https://mm-google-ads-autopilot.vercel.app/api/slack/interactions';
const META_ADS_URL = 'https://mm-meta-ads-autopilot.vercel.app/api/slack/interactions';

export async function POST(req: Request) {
  const body = await req.text();

  // Parse the payload — Slack sends as application/x-www-form-urlencoded
  // with a `payload` field containing URL-encoded JSON.
  let actionId = '';
  let payloadType = '';
  let callbackId = '';
  try {
    const params = new URLSearchParams(body);
    const payload = JSON.parse(params.get('payload') ?? '{}');
    payloadType = payload?.type ?? '';
    actionId = payload?.actions?.[0]?.action_id ?? '';
    callbackId = payload?.view?.callback_id ?? '';
  } catch {
    console.warn('[router] failed to parse payload — returning 200 to Slack');
    return new Response('', { status: 200 });
  }

  // ── Routing table ─────────────────────────────────────────────────────────

  const targets = resolveTargets(actionId, payloadType, callbackId);

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

function resolveTargets(actionId: string, payloadType: string, callbackId: string): string[] {
  // Action_ids exclusive to Google Ads Autopilot (McQueen)
  const GOOGLE_ADS_ONLY: string[] = [
    'intervene_action',
    'approve_group',
    'reject_group',
  ];

  // Action_ids shared between both autopilots — fan-out to both.
  // Each autopilot's DB race-guard ensures the action executes exactly once.
  const SHARED: string[] = [
    'approve_action',
    'reject_action',
  ];

  // Google Ads campaign builder uses dynamic action_ids with these prefixes
  if (actionId.startsWith('mm_campaign_approve_') || actionId.startsWith('mm_campaign_reject_')) {
    return [GOOGLE_ADS_URL];
  }

  if (GOOGLE_ADS_ONLY.includes(actionId)) {
    return [GOOGLE_ADS_URL];
  }

  if (SHARED.includes(actionId)) {
    return [GOOGLE_ADS_URL, META_ADS_URL];
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

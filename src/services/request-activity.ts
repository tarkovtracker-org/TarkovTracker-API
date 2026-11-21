import type { QuotaDecision } from '../authentication';
import type { Env } from '../types';
export type ActivityEndpoint =
  | 'GET /token'
  | 'GET /progress'
  | 'GET /team/progress'
  | 'POST /progress/level/{level}'
  | 'POST /progress/task/objective/{id}'
  | 'POST /progress/task/{id}'
  | 'POST /progress/tasks';
function clientLabel(userAgent: string, token: string): string | null {
  // Accept only the initial product name. Drop versions, comments, URLs and browser fingerprints.
  const product = /^([a-z][a-z0-9.-]{0,47})\/[0-9][a-z0-9.-]*(?:\s|$)/i.exec(userAgent)?.[1];
  if (
    !product ||
    /^mozilla$/i.test(product) ||
    token.toLowerCase().startsWith(product.toLowerCase())
  ) {
    return null;
  }
  return product.toLowerCase();
}
export async function recordRequestActivity(
  env: Env,
  { endpoint, decision }: { endpoint: ActivityEndpoint; decision: QuotaDecision },
  status: number,
  userAgent: string,
  rawToken: string
): Promise<void> {
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_api_request_activity`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        p_user_id: decision.userId,
        p_token_id: decision.tokenId,
        p_occurred_at: decision.at,
        p_endpoint: endpoint,
        p_client: clientLabel(userAgent, rawToken),
        p_status: status,
        p_kind: decision.kind,
        p_outcome: decision.outcome,
        p_limit: decision.limit,
        p_remaining: decision.remaining,
        p_reset_at_ms: decision.resetAt,
      }),
    });
    if (!response.ok && response.status !== 404) {
      console.warn('record_api_request_activity failed', { status: response.status });
    }
  } catch {
    console.warn('record_api_request_activity unavailable');
  }
}

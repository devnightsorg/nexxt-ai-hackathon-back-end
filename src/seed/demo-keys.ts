import { createHmac } from 'node:crypto';
import { API_KEY_PREFIX } from '../auth/api-keys.service';

export const DEMO_KEY_NAME = 'Demo persona agent';
export const DEMO_KEY_MAX_AMOUNT = 5000;

/** Deterministic demo API key: `rk_live_` + first 32 chars of base64url(HMAC-SHA256(jwtSecret, 'demo-key:' + personaKey)). */
export function demoApiKey(jwtSecret: string, personaKey: string): string {
  const mac = createHmac('sha256', jwtSecret).update('demo-key:' + personaKey).digest('base64url');
  return API_KEY_PREFIX + mac.slice(0, 32);
}

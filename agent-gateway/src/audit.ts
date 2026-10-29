import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './crypto.js';
import type { ErrorCode } from './types.js';

export interface AuditEvent {
  audit_id: string;
  ts: string;
  event: string;
  result: 'allow' | 'deny' | 'info';
  actor?: string;
  agent_id?: string;
  owner_id?: string;
  mandate_id?: string;
  action?: string;
  product_id?: string;
  amount_cents?: number;
  error_code?: ErrorCode;
  reason?: string;
  request_id?: string;
  idempotency_key?: string;
}

export type AuditInput = Omit<AuditEvent, 'audit_id' | 'ts'>;

/**
 * Append-only JSON Lines file. Never pass secrets, keys, passports or signatures in here -
 * only identifiers, decisions and reasons.
 */
export class AuditLog {
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly echo = false,
  ) {
    this.file = path.join(dataDir, 'audit.jsonl');
  }

  record(input: AuditInput): AuditEvent {
    const event: AuditEvent = { audit_id: `aud-${randomToken(8)}`, ts: this.now().toISOString(), ...input };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8');
    if (this.echo) {
      const who = event.agent_id ?? event.actor ?? '-';
      const code = event.error_code ? ` ${event.error_code}` : '';
      console.log(`[audit] ${event.result.toUpperCase()} ${event.event} ${who}${code} ${event.reason ?? ''}`.trim());
    }
    return event;
  }

  /** Latest first. */
  list(limit = 200): AuditEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent)
      .reverse()
      .slice(0, limit);
  }
}

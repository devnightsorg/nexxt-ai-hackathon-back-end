import type { AuditEvent } from './audit.js';
import type { ErrorCode } from './types.js';

// Read-only figures derived from the audit log of this demo run. SIMULATED - not bank KPIs.

export interface ChannelStats {
  notice: string;
  unique_agents_with_executions: number;
  simulated_deposits_executed: number;
  simulated_deposit_volume_cents: number;
  denied_agent_actions: number;
  denied_by_error_code: Partial<Record<ErrorCode, number>>;
}

export const SIMULATED_NOTICE = 'SIMULATED DATA - NOT REAL DEPOSITS / NOT BANK KPIs';

export function computeChannelStats(events: AuditEvent[]): ChannelStats {
  // Only real (mock) placements count. Simulations, idempotent replays and denials have other event names.
  const executed = events.filter((e) => e.event === 'execute_deposit_mock.executed' && e.result === 'allow');
  // Agent-facing denials: MCP auth failures and tool denials. Admin login failures are not agent actions.
  const denied = events.filter((e) => e.result === 'deny' && e.event !== 'admin.auth_failed');
  const byCode: Partial<Record<ErrorCode, number>> = {};
  for (const e of denied) if (e.error_code) byCode[e.error_code] = (byCode[e.error_code] ?? 0) + 1;
  return {
    notice: SIMULATED_NOTICE,
    unique_agents_with_executions: new Set(executed.map((e) => e.agent_id)).size,
    simulated_deposits_executed: executed.length,
    simulated_deposit_volume_cents: executed.reduce((sum, e) => sum + (e.amount_cents ?? 0), 0),
    denied_agent_actions: denied.length,
    denied_by_error_code: byCode,
  };
}

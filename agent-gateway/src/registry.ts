import path from 'node:path';
import { JsonFile } from './store.js';
import type { AgentRecord } from './types.js';

export class AgentRegistry {
  private readonly file: JsonFile<Record<string, AgentRecord>>;

  constructor(dataDir: string) {
    this.file = new JsonFile(path.join(dataDir, 'agents.json'), () => ({}));
  }

  get(agentId: string): AgentRecord | undefined {
    return this.file.read()[agentId];
  }

  list(): AgentRecord[] {
    return Object.values(this.file.read());
  }

  register(record: Omit<AgentRecord, 'created_at' | 'updated_at'>, now: Date): AgentRecord {
    const ts = now.toISOString();
    const full: AgentRecord = { ...record, created_at: ts, updated_at: ts };
    this.file.update((all) => {
      if (all[record.agent_id]) throw new Error(`agent ${record.agent_id} already registered`);
      all[record.agent_id] = full;
    });
    return full;
  }

  setStatus(agentId: string, status: AgentRecord['status'], reason: string, now: Date): AgentRecord {
    let updated: AgentRecord | undefined;
    this.file.update((all) => {
      const rec = all[agentId];
      if (!rec) throw new Error(`agent ${agentId} not found`);
      rec.status = status;
      rec.status_reason = reason;
      rec.updated_at = now.toISOString();
      updated = rec;
    });
    return updated!;
  }
}

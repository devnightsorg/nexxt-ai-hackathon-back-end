import { z } from 'zod';
import {
  executionSchema,
  offerSchema,
  simulationSchema,
  type BankAdapter,
  type Execution,
  type ExecuteRequest,
  type Offer,
  type SimulateRequest,
  type Simulation,
} from './types.js';

/** Calls the teammates' banking backend (BANK_AGENT_URL). Responses are validated, never trusted blindly. */
export class HttpBankAdapter implements BankAdapter {
  readonly kind = 'http' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  private async call<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/'), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`bank backend ${method} ${path} returned HTTP ${res.status}`);
    return schema.parse(await res.json());
  }

  listOffers(): Promise<Offer[]> {
    return this.call(z.array(offerSchema), 'GET', 'offers');
  }

  simulateDeposit(req: SimulateRequest): Promise<Simulation> {
    return this.call(simulationSchema, 'POST', 'deposits/simulate', req);
  }

  executeDeposit(req: ExecuteRequest): Promise<Execution> {
    return this.call(executionSchema, 'POST', 'deposits/execute', req);
  }
}

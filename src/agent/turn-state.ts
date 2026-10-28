import type { ProposalDto } from '../actions/actions.service';
import type { Projection } from '../finance/projection';

export interface Recommendation {
  productSlug: string;
  productName: string;
  category: string;
  why: string;
  suggestedAmount: number | null;
  termMonths: number | null;
  monthlyContribution: number | null;
  projection: Projection | null;
}

export interface Citation {
  title: string;
  sourceUrl: string | null;
}

/** Structured side-effects collected while the agent runs one turn. */
export interface TurnState {
  recommendations: Recommendation[];
  proposals: ProposalDto[];
  citations: Citation[];
  allowedRates: number[];
}

export function newTurnState(): TurnState {
  return { recommendations: [], proposals: [], citations: [], allowedRates: [] };
}

export function addCitation(turn: TurnState, c: Citation): void {
  if (!turn.citations.some((x) => x.title === c.title && x.sourceUrl === c.sourceUrl)) turn.citations.push(c);
}

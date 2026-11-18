import { z } from 'zod';

/** The four action risk levels. `high` and `critical` require explicit user approval. */
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const riskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** Numeric ordering for comparisons (higher = riskier). */
export const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Whether an action at this risk level must be approved before it runs. */
export function requiresApproval(level: RiskLevel): boolean {
  return RISK_ORDER[level] >= RISK_ORDER.high;
}

/** Returns the higher of two risk levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

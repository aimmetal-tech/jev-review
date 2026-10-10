import type { Verdict } from "./reviewer.ts";

/** Denial is a recovery signal, not a request to interrupt the user immediately. */
export class RecoveryBudget {
  private failures = 0;
  reset(): void { this.failures = 0; }
  outcome(verdict: Verdict, humanAfter: number): { human: boolean; exhausted: boolean; reason: string } {
    if (verdict.decision === "allow") { this.reset(); return { human: false, exhausted: false, reason: verdict.reason }; }
    this.failures++;
    const exhausted = this.failures >= humanAfter;
    const hint = verdict.alternative ?? "Try a materially safer operation within the existing sandbox permissions.";
    return { human: exhausted && verdict.decision === "review", exhausted,
      reason: `${verdict.reason}. ${exhausted ? "Automatic recovery budget exhausted; stop and request a clarified scope." : hint}` };
  }
}

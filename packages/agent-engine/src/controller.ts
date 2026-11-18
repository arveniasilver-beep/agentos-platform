export type ApprovalDecision = 'approve' | 'deny';

/**
 * Per-run control surface: the instant kill switch and the approval channel. The API/worker
 * holds a reference and calls requestStop()/decideApproval() in response to user actions.
 * Approval decisions are order-independent — a decision may arrive before the engine awaits it.
 */
export class RunController {
  private stopped = false;
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();
  private readonly decided = new Map<string, ApprovalDecision>();

  /** Instant stop. Resolves any in-flight approval as a deny so the loop can unwind. */
  requestStop(): void {
    this.stopped = true;
    for (const [id, resolve] of this.pending) {
      resolve('deny');
      this.pending.delete(id);
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** Resolve an approval. If the engine isn't awaiting yet, the decision is buffered. */
  decideApproval(approvalId: string, decision: ApprovalDecision): void {
    const resolve = this.pending.get(approvalId);
    if (resolve) {
      resolve(decision);
      this.pending.delete(approvalId);
    } else {
      this.decided.set(approvalId, decision);
    }
  }

  /** Awaited by the engine when a risky tool needs approval. */
  awaitApproval(approvalId: string): Promise<ApprovalDecision> {
    if (this.stopped) return Promise.resolve('deny');
    const buffered = this.decided.get(approvalId);
    if (buffered !== undefined) {
      this.decided.delete(approvalId);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve) => {
      this.pending.set(approvalId, resolve);
    });
  }
}

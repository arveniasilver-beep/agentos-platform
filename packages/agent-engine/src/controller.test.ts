import { describe, it, expect } from 'vitest';
import { RunController } from './controller';

describe('RunController', () => {
  it('resolves an approval awaited before the decision', async () => {
    const c = new RunController();
    const p = c.awaitApproval('a1');
    c.decideApproval('a1', 'approve');
    expect(await p).toBe('approve');
  });

  it('resolves an approval decided before it is awaited (order-independent)', async () => {
    const c = new RunController();
    c.decideApproval('a1', 'deny');
    expect(await c.awaitApproval('a1')).toBe('deny');
  });

  it('requestStop resolves pending approvals as deny and flags stopped', async () => {
    const c = new RunController();
    const p = c.awaitApproval('a1');
    c.requestStop();
    expect(await p).toBe('deny');
    expect(c.isStopped()).toBe(true);
  });

  it('awaitApproval returns deny immediately once stopped', async () => {
    const c = new RunController();
    c.requestStop();
    expect(await c.awaitApproval('a2')).toBe('deny');
  });
});

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobileApprovals, MobileWorkflows, StatusDot, Empty } from './MobileScreens';
import type { SyncSnapshot } from '../../lib/api';
import MobilePage from '../../app/m/page';

const emptySnap: SyncSnapshot = { tasks: [], approvals: [], artifacts: [], automationRuns: [], unreadNotifications: 0, serverTime: '' };

describe('Mobile control panel smoke (TICKET-6)', () => {
  it('flag OFF: /m page renders the disabled stub (desktop web untouched)', () => {
    // NEXT_PUBLIC_MOBILE_CONTROL_PANEL_ENABLED is unset in the test env => flag is false.
    const html = renderToStaticMarkup(<MobilePage />);
    expect(html).toMatch(/not enabled/i);
    expect(html).not.toMatch(/bottom-0/); // the shell (with bottom nav) is NOT rendered
  });

  it('approval queue renders action + Approve/Deny from a snapshot (mobile-safe, no API call)', () => {
    const snap: SyncSnapshot = {
      ...emptySnap,
      approvals: [{ id: '1', approvalId: 'a1', taskId: 't1', action: 'shell_exec', risk: 'critical', elevated: true, requestedAt: '' }],
    };
    const html = renderToStaticMarkup(<MobileApprovals workspaceId="w" snap={snap} onChanged={() => {}} />);
    expect(html).toContain('shell_exec');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).toMatch(/CONFIRM-ELEVATED/); // elevated approval shows the typed-confirmation input
  });

  it('empty approvals shows a friendly empty state', () => {
    expect(renderToStaticMarkup(<MobileApprovals workspaceId="w" snap={emptySnap} onChanged={() => {}} />)).toMatch(/No pending approvals/i);
  });

  it('workflows view renders (TICKET-8 real view, initial loading state)', () => {
    const html = renderToStaticMarkup(<MobileWorkflows workspaceId="w" onBack={() => {}} />);
    expect(html).toMatch(/Workflows/);
    expect(html).toMatch(/Loading/i); // lists load on mount; initial render shows loading
  });

  it('presentational helpers render', () => {
    expect(renderToStaticMarkup(<StatusDot status="running" />)).toContain('rounded-full');
    expect(renderToStaticMarkup(<Empty label="nothing here" />)).toContain('nothing here');
  });
});

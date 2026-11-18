// The integration test creates/reads RLS-protected rows (e.g. secrets) via the raw client. Enter
// system (RLS-bypass) context for the test worker so those queries aren't denied by Row-Level
// Security.
import { tenantContext } from './src/tenant-context';

tenantContext.enterSystem();

// Live-DB integration tests exercise application logic (not RLS) and use the shared raw client, so
// without a tenancy context their queries on RLS-protected tables would be denied. Enter system
// (RLS-bypass) context for the test worker. Tests that specifically verify RLS enforcement override
// this with an explicit workspace context per query (tenantContext.run(...)).
import { tenantContext } from '@agentos/db';

tenantContext.enterSystem();

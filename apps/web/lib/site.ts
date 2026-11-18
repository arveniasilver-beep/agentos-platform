import { BRAND } from '@agentos/brand';
import { PROTOCOL_VERSION } from '@agentos/protocol';

export interface SiteInfo {
  name: string;
  shortName: string;
  protocolVersion: string;
}

/** Site identity derived entirely from the shared brand + protocol packages (no local literals). */
export function getSiteInfo(): SiteInfo {
  return {
    name: BRAND.appName,
    shortName: BRAND.appNameShort,
    protocolVersion: PROTOCOL_VERSION,
  };
}

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

interface ReqWithApiContext {
  apiContext?: { keyId?: string };
  ip?: string;
}

/**
 * Throttles the public API per API KEY rather than per IP (runs after ApiKeyGuard, so apiContext is
 * set). Combined with the per-IP ThrottlerGuard, this caps a single key's spend even if the caller
 * rotates source IPs. Falls back to IP if no key context is present.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as ReqWithApiContext;
    return Promise.resolve(`key:${r.apiContext?.keyId ?? r.ip ?? 'anon'}`);
  }
}

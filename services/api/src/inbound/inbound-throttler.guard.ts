import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

interface ReqWithToken {
  params?: { token?: string };
  ip?: string;
}

/**
 * Per-token rate limiter for the inbound-email webhook. The default ThrottlerGuard keys on the source
 * IP, which is wrong here: mail providers deliver from a small shared pool of egress IPs (so one
 * tenant could throttle another), and an attacker who learns a token can rotate IPs to dodge the cap.
 * The opaque `:token` path param is the real per-tenant capability, so we throttle on it instead.
 * Mirrors ApiKeyThrottlerGuard for the public API.
 */
@Injectable()
export class InboundThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as ReqWithToken;
    const token = r.params?.token;
    return Promise.resolve(token ? `inbound:${token}` : `ip:${r.ip ?? 'anon'}`);
  }
}

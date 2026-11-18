import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { loadServerEnv } from '@agentos/config';
import { AuthService, type SessionUser } from './auth.service';
import { SESSION_COOKIE } from './cookie';

interface RequestWithAuth {
  cookies?: Record<string, string | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  user?: SessionUser;
  deviceId?: string;
}

/** Requires a valid session cookie (or, when DEVICE_SYNC_ENABLED, a registered Bearer device token);
 * attaches the resolved user to the request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const user = await this.auth.resolveSession(token);
      if (!user) throw new UnauthorizedException('Invalid or expired session');
      req.user = user;
      return true;
    }
    // Device Sync (TICKET-5): accept a Bearer device token only when the flag is on. Off => cookie-only
    // (byte-identical). The `aosd_` prefix distinguishes device tokens from the public-API key path.
    if (loadServerEnv().DEVICE_SYNC_ENABLED) {
      const auth = req.headers?.authorization;
      const header = Array.isArray(auth) ? auth[0] : auth;
      const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
      if (bearer?.startsWith('aosd_')) {
        const device = await this.auth.resolveDevice(bearer);
        if (!device) throw new UnauthorizedException('Invalid or revoked device');
        req.user = { id: device.id, email: device.email, displayName: device.displayName };
        req.deviceId = device.deviceId;
        return true;
      }
    }
    throw new UnauthorizedException('Not authenticated');
  }
}

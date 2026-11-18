import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { loadServerEnv } from '@agentos/config';
import { AuthService, type SessionUser } from './auth.service';
import { AuthGuard } from './auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { registerSchema, loginSchema, type RegisterDto, type LoginDto } from './dto';
import { SESSION_COOKIE, COOKIE_OPTS } from './cookie';

const LOGIN_THROTTLE = (() => {
  const env = loadServerEnv();
  return { default: { limit: env.AUTH_LOGIN_RATE_LIMIT, ttl: env.AUTH_RATE_WINDOW_SEC * 1000 } };
})();

interface ReplyLike {
  setCookie(name: string, value: string, opts: Record<string, unknown>): unknown;
  clearCookie(name: string, opts?: Record<string, unknown>): unknown;
}
interface RequestLike {
  headers: Record<string, string | undefined>;
  ip?: string;
  cookies?: Record<string, string | undefined>;
  user?: SessionUser;
}

@Controller('auth')
@UseGuards(ThrottlerGuard) // brute-force protection on register/login/me/logout (per-IP)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Req() req: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ user: SessionUser }> {
    const user = await this.auth.register(dto);
    const token = await this.auth.createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS);
    return { user };
  }

  @Post('login')
  @Throttle(LOGIN_THROTTLE) // tighter per-IP cap on the brute-force target
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() req: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ user: SessionUser }> {
    const user = await this.auth.login(dto);
    const token = await this.auth.createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS);
    return { user };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: RequestLike): { user: SessionUser | undefined } {
    return { user: req.user };
  }

  @Post('logout')
  async logout(
    @Req() req: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ ok: true }> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await this.auth.destroySession(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { loadServerEnv } from '@agentos/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const env = loadServerEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: env.MAX_BODY_BYTES, trustProxy: env.TRUST_PROXY }),
  );
  await app.register(fastifyCookie);
  // Security headers. CSP is off (this is a JSON API, not an HTML origin); CORP is cross-origin so
  // the SPA/desktop shell can fetch the API; COEP off to avoid blocking those cross-origin reads.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  // The SPA (web origin) and desktop shell (app:// origin) are cross-origin and send the session
  // cookie. In production an explicit allowlist is REQUIRED — refuse to reflect every origin with
  // credentials (that would allow any site to make credentialed cross-origin reads). In dev we
  // reflect the request origin for convenience.
  if (env.NODE_ENV === 'production' && !env.CORS_ORIGINS) {
    throw new Error(
      'CORS_ORIGINS must be set in production: refusing to reflect all origins with credentials.',
    );
  }
  const corsOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : true;
  app.enableCors({ origin: corsOrigins, credentials: true });
  // Socket.IO binds to the same underlying HTTP server (used by the live task event gateway).
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.enableShutdownHooks();
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  console.log(`[api] listening on http://localhost:${env.API_PORT}`);
  // Surface the durability posture at boot (mirrors scripts/doctor.ps1). EXECUTION_MODE=inline runs tasks
  // in-process: a crash/restart loses in-flight work and scheduled automations never fire. This is only a
  // warning — it changes no behavior — but it makes the "runs non-durably in practice" gap visible.
  if (env.EXECUTION_MODE === 'inline') {
    console.warn(
      `[api] WARNING: EXECUTION_MODE=inline — tasks are NOT durable (in-flight work is lost on crash/restart) and automations never fire. For a durable runtime set EXECUTION_MODE=queue + RESUME_ENABLED=true with a worker running.`,
    );
  }
}

void bootstrap();

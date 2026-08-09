import argon2 from 'argon2'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Logger } from './logger.js'

const loginBodySchema = z.object({ password: z.string().min(1) })

const SESSION_COOKIE = 'domovoi_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/** Paths that must work without a session, whatever the auth setting. */
function isPublicPath(url: string): boolean {
  return (
    // Webhooks carry their own secret, and are used by clients that can't log in.
    url.startsWith('/api/webhooks/') ||
    url.startsWith('/api/auth/') ||
    url === '/api/health' ||
    // Everything not under /api is the SPA shell, which needs to load in order
    // to render the login form at all.
    !url.startsWith('/api/')
  )
}

/**
 * Host-header allowlist.
 *
 * This runs whether or not authentication is enabled, because DNS rebinding is
 * the one attack a browser can mount against an open service on someone's LAN:
 * a malicious page resolves its own hostname to Domovoi's private IP and then
 * drives it with the user's own browser. Checking Host closes that off, and
 * costs a correctly-configured user nothing.
 */
function isAllowedHost(host: string | undefined, extra: string[]): boolean {
  if (!host) return false
  const hostname = (host.split(':')[0] ?? '').toLowerCase()
  if (extra.includes(hostname)) return true

  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
    return true
  }
  // Bare IPv4/IPv6 literals — someone reaching the box directly by address.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  if (hostname.startsWith('[') || hostname.includes(':')) return true
  // Tailscale and similar; a real domain is expected to be listed explicitly.
  if (hostname.endsWith('.ts.net')) return true

  return false
}

export type AuthDeps = {
  config: Config
  logger: Logger
}

export async function registerAuth(app: FastifyInstance, { config, logger }: AuthDeps) {
  const enabled = !!config.password
  const passwordHash = config.password ? await argon2.hash(config.password) : undefined

  // Signing the cookie means a session value can't be forged without the secret.
  const secret =
    config.sessionSecret ?? (enabled ? undefined : 'domovoi-unauthenticated-placeholder')
  if (enabled && !secret) {
    logger.warn(
      'DOMOVOI_PASSWORD is set without DOMOVOI_SESSION_SECRET — sessions will not survive a restart',
    )
  }

  const cookie = await import('@fastify/cookie')
  await app.register(cookie.default, {
    secret: config.sessionSecret ?? 'domovoi-dev-secret',
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host, config.allowedHosts)) {
      logger.warn({ host: request.headers.host }, 'rejected request with unexpected Host header')
      return reply.status(421).send({
        error: 'bad_host',
        message:
          'Unexpected Host header. Add this hostname to DOMOVOI_ALLOWED_HOSTS if it is yours.',
      })
    }

    if (!enabled) return
    if (isPublicPath(request.url)) return

    const session = request.cookies[SESSION_COOKIE]
    const unsigned = session ? request.unsignCookie(session) : undefined
    if (!unsigned?.valid) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Sign in required' })
    }
  })

  app.get('/api/auth/status', async () => ({ required: enabled }))

  app.post('/api/auth/login', async (request, reply) => {
    if (!enabled) return { ok: true }

    const body = loginBodySchema.parse(request.body)
    const ok = passwordHash ? await argon2.verify(passwordHash, body.password) : false
    if (!ok) {
      // Uniform failure: no distinction between wrong password and anything else.
      return reply.status(401).send({ error: 'unauthorized', message: 'Incorrect password' })
    }

    return reply
      .setCookie(SESSION_COOKIE, 'ok', {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
        // Not `secure`: this is normally plain HTTP on a LAN, and setting it
        // would silently break login for exactly the default deployment.
        secure: false,
      })
      .send({ ok: true })
  })

  app.post('/api/auth/logout', async (_request, reply) =>
    reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true }),
  )

  if (enabled) {
    logger.info('authentication enabled')
  } else {
    logger.warn(
      'No DOMOVOI_PASSWORD set — the UI is open to anyone on the network. This is the default; set a password to require a login.',
    )
  }
}

export const __testing = { isAllowedHost, isPublicPath }

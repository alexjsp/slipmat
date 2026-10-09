import { createHmac, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from './config.js'
import type { Logger } from './logger.js'
import { LoginThrottle } from './login-throttle.js'
import type { SettingsStore } from './settings.js'

const loginBodySchema = z.object({ password: z.string().min(1) })

const SESSION_COOKIE = 'slipmat_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Routes that must work without a session, whatever the auth setting.
 *
 * Takes the *matched route pattern*, never the raw URL. The router
 * percent-decodes before matching, so `/%61pi/system` reaches the
 * `/api/system` handler while its raw URL doesn't start with `/api/` at all —
 * checking the URL let every route through unauthenticated that way.
 */
function isPublicRoute(route: string | undefined): boolean {
  // Unmatched: a 404, or the SPA fallback. Nothing behind it to protect.
  if (route === undefined) return true
  return (
    // Webhooks carry their own secret, and are used by clients that can't log in.
    route.startsWith('/api/webhooks/') ||
    route.startsWith('/api/auth/') ||
    route === '/api/health' ||
    // Everything not under /api is the SPA shell, which needs to load in order
    // to render the login form at all.
    !route.startsWith('/api/')
  )
}

/**
 * A state-changing request sent by some other site's page.
 *
 * With no password set (the default) a page on any website can POST to
 * Slipmat by IP from the visitor's browser — no preflight is needed for a body-less
 * or text/plain request — and pause the house or rotate tokens. Browsers always
 * send Origin on such requests, so a mismatch with our own host gives it away.
 * Hostnames only: the dev proxy and reverse proxies change the port.
 */
function isCrossSiteWrite(request: FastifyRequest, extra: string[]): boolean {
  if (SAFE_METHODS.has(request.method)) return false
  const origin = request.headers.origin
  // Shortcuts, curl and Node-RED send no Origin; they are not a browser being
  // steered by a page.
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).hostname.toLowerCase()
  } catch {
    // Includes the literal `null` sent by sandboxed and file:// pages.
    return true
  }
  const ours = [request.hostname, hostnameOf(request.headers.host)].map((h) => h.toLowerCase())
  return !ours.includes(originHost) && !extra.includes(originHost)
}

function hostnameOf(host: string | undefined): string {
  if (!host) return ''
  // Bracketed IPv6 keeps its colons; anything else loses a trailing port.
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0] ?? ''
}

/**
 * Host-header allowlist.
 *
 * This runs whether or not authentication is enabled, because DNS rebinding is
 * the one attack a browser can mount against an open service on someone's LAN:
 * a malicious page resolves its own hostname to Slipmat's private IP and then
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
  settings: SettingsStore
}

export async function registerAuth(app: FastifyInstance, { config, logger, settings }: AuthDeps) {
  const enabled = !!config.password
  const passwordHash = config.password ? await argon2.hash(config.password) : undefined

  // Signing the cookie means a session value can't be forged without the
  // secret, so with none configured one is generated and kept in the database.
  // It used to fall back to a string literal published in this file, which
  // let anyone sign their own session cookie.
  const secret = config.sessionSecret ?? settings.sessionSecret()

  // Sessions are ids held server-side, so signing out actually ends one: a
  // signed constant stayed valid wherever it had been copied. Each carries a
  // tag derived from the password, so changing the password ends them all.
  const passwordTag = config.password
    ? createHmac('sha256', secret).update(config.password).digest('base64url')
    : undefined
  const sessions = new Map(Object.entries(settings.sessions()))
  const saveSessions = () => settings.setSessions(Object.fromEntries(sessions))
  const isLiveSession = (id: string) => {
    const session = sessions.get(id)
    return !!session && session.tag === passwordTag && session.expiresAt > Date.now()
  }
  const sessionIdFrom = (request: FastifyRequest) => {
    const cookie = request.cookies[SESSION_COOKIE]
    const unsigned = cookie ? request.unsignCookie(cookie) : undefined
    return unsigned?.valid ? unsigned.value : null
  }

  const cookie = await import('@fastify/cookie')
  await app.register(cookie.default, { secret })

  app.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host, config.allowedHosts)) {
      logger.warn({ host: request.headers.host }, 'rejected request with unexpected Host header')
      return reply.status(421).send({
        error: 'bad_host',
        message:
          'Unexpected Host header. Add this hostname to SLIPMAT_ALLOWED_HOSTS if it is yours.',
      })
    }

    const route = request.routeOptions.url
    if (isCrossSiteWrite(request, config.allowedHosts) && !route?.startsWith('/api/webhooks/')) {
      logger.warn({ origin: request.headers.origin }, 'rejected cross-site request')
      return reply
        .status(403)
        .send({ error: 'cross_site', message: 'Cross-site requests are not allowed' })
    }

    if (!enabled) return
    if (isPublicRoute(route)) return

    const sessionId = sessionIdFrom(request)
    if (!sessionId || !isLiveSession(sessionId)) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Sign in required' })
    }
  })

  app.get('/api/auth/status', async () => ({ required: enabled }))

  const throttle = new LoginThrottle()

  app.post('/api/auth/login', async (request, reply) => {
    if (!enabled) return { ok: true }

    // Checked before the password, so a locked-out guesser learns nothing from
    // trying anyway.
    const waitMs = throttle.retryAfterMs(request.ip)
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000)
      return reply
        .status(429)
        .header('retry-after', String(seconds))
        .send({ error: 'too_many_attempts', message: 'Too many attempts. Try again later.' })
    }

    const body = loginBodySchema.parse(request.body)
    const ok = passwordHash ? await argon2.verify(passwordHash, body.password) : false
    if (!ok) {
      throttle.recordFailure(request.ip)
      logger.warn({ ip: request.ip }, 'failed login')
      // Uniform failure: no distinction between wrong password and anything else.
      return reply.status(401).send({ error: 'unauthorized', message: 'Incorrect password' })
    }
    throttle.recordSuccess(request.ip)

    // Expired sessions, and ones from an earlier password, go when a new one starts.
    for (const id of sessions.keys()) if (!isLiveSession(id)) sessions.delete(id)
    const sessionId = randomBytes(24).toString('base64url')
    sessions.set(sessionId, {
      expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      tag: passwordTag ?? '',
    })
    saveSessions()

    return reply
      .setCookie(SESSION_COOKIE, sessionId, {
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

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = sessionIdFrom(request)
    if (sessionId && sessions.delete(sessionId)) saveSessions()
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).send({ ok: true })
  })

  if (enabled) {
    logger.info('authentication enabled')
  } else {
    logger.warn(
      'No SLIPMAT_PASSWORD set — the UI is open to anyone on the network. This is the default; set a password to require a login.',
    )
  }
}

export const __testing = { isAllowedHost, isPublicRoute }

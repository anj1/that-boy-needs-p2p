import { DurableObject } from 'cloudflare:workers'
import { roomIdPattern, signalLimit } from '../src/pairing-protocol.js'
import { issueTurnCredentials, turnConfig, TurnSetupError } from './turn.js'

const inviteLifetimeMs = 10 * 60 * 1000
const open = (socket) => socket?.readyState === WebSocket.OPEN

function send(socket, type, payload) {
  if (open(socket)) socket.send(JSON.stringify({ type, payload }))
}

function close(socket, code, reason) {
  if (open(socket)) socket.close(code, reason)
}

export default {
  async fetch(request, env) {
    const [, prefix, id, role, extra] = new URL(request.url).pathname.split('/')
    if (prefix !== 'room' || !roomIdPattern.test(id ?? '') || !['host', 'guest'].includes(role) || extra !== undefined) {
      return new Response('Not found', { status: 404 })
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket required', { status: 426 })
    }
    const origins = env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())
    if (!origins.includes(request.headers.get('Origin'))) {
      return new Response('Unknown origin', { status: 403 })
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    const { success } = await env.PAIRING_LIMIT.limit({ key: ip })
    if (!success) return new Response('Too many pairing attempts', { status: 429 })

    return env.ROOMS.getByName(id).fetch(request)
  },
}

export class PairingRoom extends DurableObject {
  socket(role) {
    return this.ctx.getWebSockets(role).find(open)
  }

  reject(reason) {
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    close(server, 4000, reason)
    return new Response(null, { status: 101, webSocket: client })
  }

  async fetch(request) {
    try {
      turnConfig(this.env)
    } catch (error) {
      if (error instanceof TurnSetupError) return this.reject(error.message)
      throw error
    }
    const role = new URL(request.url).pathname.split('/').at(-1)
    return this.ctx.blockConcurrencyWhile(async () => {
      const expires = await this.ctx.storage.getAlarm()
      if (role === 'host') {
        if (expires || this.socket('host')) return this.reject('This invite is already in use.')
        await this.ctx.storage.setAlarm(Date.now() + inviteLifetimeMs)
      } else if (!expires || expires <= Date.now() || !this.socket('host')) {
        return this.reject('This invite expired or its host left. Ask for a new link.')
      } else if (this.socket('guest')) {
        return this.reject('This invite already has a guest. Ask for a new link.')
      }

      const { 0: client, 1: server } = new WebSocketPair()
      this.ctx.acceptWebSocket(server, [role])
      server.serializeAttachment({ role, phase: role === 'host' ? 'waiting' : 'start' })
      send(server, 'ready')
      return new Response(null, { status: 101, webSocket: client })
    })
  }

  async webSocketMessage(socket, data) {
    const state = socket.deserializeAttachment()
    if (!state || !open(socket)) return
    if (typeof data !== 'string' || data.length > signalLimit + 100) {
      this.finish(4000, 'Invalid pairing message.')
      return
    }

    let message
    try {
      message = JSON.parse(data)
    } catch {
      this.finish(4000, 'Invalid pairing message.')
      return
    }
    const { role, phase } = state
    const host = this.socket('host')
    const guest = this.socket('guest')
    if (role === 'guest' && phase === 'start' && message?.type === 'start' && open(host)) {
      socket.serializeAttachment({ role, phase: 'provisioning' })
      try {
        const [hostIce, guestIce] = await Promise.all([
          issueTurnCredentials(this.env),
          issueTurnCredentials(this.env),
        ])
        if (!open(host) || !open(guest)) return
        host.serializeAttachment({ role: 'host', phase: 'offer' })
        guest.serializeAttachment({ role: 'guest', phase: 'waiting' })
        send(guest, 'ice', guestIce)
        send(host, 'ice', hostIce)
      } catch (error) {
        this.finish(4000, error instanceof TurnSetupError ? error.message : 'Could not provision TURN credentials.')
      }
      return
    }

    if (typeof message?.payload !== 'string' || message.payload.length > signalLimit || !/^[A-Za-z0-9_-]+$/.test(message.payload)) {
      this.finish(4000, 'Invalid pairing message.')
      return
    }
    if (role === 'host' && phase === 'offer' && message.type === 'offer' && open(guest)) {
      host.serializeAttachment({ role, phase: 'waiting' })
      guest.serializeAttachment({ role: 'guest', phase: 'answer' })
      send(guest, 'offer', message.payload)
    } else if (role === 'guest' && phase === 'answer' && message.type === 'answer' && open(host)) {
      send(host, 'answer', message.payload)
      send(guest, 'paired')
      this.finish(1000, 'Pairing complete.')
    } else {
      this.finish(4000, 'Unexpected pairing message.')
    }
  }

  finish(code, reason) {
    for (const role of ['host', 'guest']) close(this.socket(role), code, reason)
  }

  webSocketClose(socket) {
    if (socket.deserializeAttachment()) this.finish(4000, 'Your peer left before pairing finished.')
  }

  webSocketError(socket) {
    if (socket.deserializeAttachment()) this.finish(4000, 'The pairing connection was interrupted.')
  }

  alarm() {
    this.finish(4000, 'The invite expired. Create a new link.')
  }
}

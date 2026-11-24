import { decodeBytes, decodeToken, encodeBytes, encodeToken, version } from './crypto.js'
import { roomIdPattern, signalLimit } from './pairing-protocol.js'

export function newInvite() {
  return {
    v: version,
    room: encodeBytes(crypto.getRandomValues(new Uint8Array(24))),
    secret: encodeBytes(crypto.getRandomValues(new Uint8Array(32))),
  }
}

export function inviteUrl(invite) {
  const url = new URL(location.href)
  url.search = ''
  url.hash = 'invite=' + encodeToken(invite)
  return url.href
}

export function readInvite(hash) {
  try {
    const invite = decodeToken(hash.slice('#invite='.length))
    if (invite?.v !== version || typeof invite.room !== 'string' || !roomIdPattern.test(invite.room)) throw new Error()
    decodeBytes(invite.secret, 32)
    return invite
  } catch {
    throw new Error('This invite is invalid. Ask your peer for a new link.')
  }
}

export function openSignaling(invite, host, signal) {
  const url = new URL(__SIGNAL_ORIGIN__)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/room/${invite.room}/${host ? 'host' : 'guest'}`
  const socket = new WebSocket(url)
  const defaultError = 'Could not reach the pairing service. Check the Worker URL and setup.'
  let failure
  let timer
  const onAbort = () => socket.close()
  const stream = new ReadableStream({
    start(controller) {
      timer = setTimeout(() => {
        failure = 'The pairing service did not respond. Try again.'
        socket.close()
      }, 15000)
      signal.addEventListener('abort', onAbort, { once: true })
      socket.addEventListener('message', ({ data }) => {
        try {
          if (typeof data !== 'string' || data.length > signalLimit + 1024 || (controller.desiredSize ?? 0) < -4) {
            throw new Error()
          }
          controller.enqueue(JSON.parse(data))
        } catch {
          failure = 'The pairing service sent an invalid message.'
          socket.close()
        }
      })
      socket.addEventListener('close', ({ reason }) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        failure ||= reason || defaultError
        controller.close()
      }, { once: true })
    },
  })
  const reader = stream.getReader()
  return {
    async receive(type) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) throw new Error(failure)
      if (value?.type !== type) throw new Error('The pairing service sent an unexpected message.')
      if (type === 'ready') clearTimeout(timer)
      return value.payload
    },
    send(type, payload) {
      socket.send(JSON.stringify({ type, payload }))
    },
    close() {
      socket.close()
    },
  }
}

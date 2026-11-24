import {
  createCipher, createSignalCipher, decodeBytes, encodeBytes, frameLimit,
  kem, messageLimit, signReply, verifyReply, version,
} from './crypto.js'
import { openSignaling } from './signaling.js'

const channelName = 'that-boy-needs-p2p-v2'
const keyProof = 'that-boy-needs-p2p key confirmation'

function validateDescription(value) {
  if (typeof value?.sdp !== 'string' || value.sdp.length > 16000 || value.v !== version) {
    throw new Error('Invalid WebRTC session description.')
  }
  const media = value.sdp.split(/\r?\n/).filter((line) => line.startsWith('m='))
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0])) {
    throw new Error('Expected one WebRTC data channel.')
  }
}

function waitForIce(pc, signal) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve, reject) => {
    // A blocked ICE server can slow gathering. Use the candidates available by the deadline.
    const timer = setTimeout(() => finish(), 12000)
    function finish(error) {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    function onChange() {
      if (pc.iceGatheringState === 'complete') finish()
    }
    function onAbort() { finish(signal.reason) }
    pc.addEventListener('icegatheringstatechange', onChange)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else onChange()
  })
}

export class Session {
  #pc
  #controller = new AbortController()
  #channel
  #inviteSecret
  #privateKey
  #cipher
  #connectionTimer
  #incoming = Promise.resolve()
  #pendingFrames = 0
  #confirmationSent = false
  #confirmationReceived = false
  #ready = false

  constructor(events) {
    this.events = events
  }

  #setup(iceServers) {
    if (!Array.isArray(iceServers)) throw new Error('The pairing service did not provide TURN credentials.')
    this.#pc = new RTCPeerConnection({ iceServers })
    this.#pc.onconnectionstatechange = () => {
      if (this.#pc.connectionState === 'failed') {
        this.#fail('Could not connect to the peer. Check your network and the TURN configuration.')
      }
    }
    this.#pc.ondatachannel = ({ channel }) => {
      if (this.#channel || channel.label !== channelName) channel.close()
      else this.#attach(channel)
    }
  }

  async #localDescription() {
    await waitForIce(this.#pc, this.#controller.signal)
    this.#controller.signal.throwIfAborted()
    const { sdp } = this.#pc.localDescription
    if (!/^a=candidate:/m.test(sdp)) throw new Error('WebRTC found no usable route. Check your network and TURN setup.')
    return sdp
  }

  async connect(invite, host) {
    const signal = this.#controller.signal
    this.#inviteSecret = decodeBytes(invite.secret, 32)
    const socket = openSignaling(invite, host, signal)
    try {
      const signaling = await createSignalCipher(this.#inviteSecret, invite.room)
      await socket.receive('ready')
      if (host) this.events.waiting()
      else socket.send('start')
      this.#setup(await socket.receive('ice'))
      this.events.connecting()
      this.#connectionTimer = setTimeout(() => {
        this.#fail('The peer could not be reached. Start a fresh invite and try again.')
      }, 50000)
      if (host) await this.#host(socket, signaling)
      else await this.#guest(socket, signaling)
    } finally {
      socket.close()
      this.#clearHandshake()
    }
  }

  async #host(socket, signaling) {
    const { publicKey, secretKey } = kem.keygen()
    this.#privateKey = secretKey
    this.#attach(this.#pc.createDataChannel(channelName))
    await this.#pc.setLocalDescription(await this.#pc.createOffer())
    const offer = { v: version, key: encodeBytes(publicKey), sdp: await this.#localDescription() }
    socket.send('offer', await signaling.seal('offer', offer))
    const answer = await signaling.open('answer', await socket.receive('answer'))
    validateDescription(answer)
    const secret = this.#inviteSecret
    this.#controller.signal.throwIfAborted()
    if (!await verifyReply(secret, offer, answer)) throw new Error('The reply failed authentication.')
    this.#controller.signal.throwIfAborted()
    const sharedSecret = kem.decapsulate(decodeBytes(answer.kem, kem.lengths.cipherText), this.#privateKey)
    const cipher = await createCipher(secret, sharedSecret, offer, answer, true)
    this.#controller.signal.throwIfAborted()
    this.#cipher = cipher
    await this.#pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
  }

  async #guest(socket, signaling) {
    const offer = await signaling.open('offer', await socket.receive('offer'))
    validateDescription(offer)
    this.#controller.signal.throwIfAborted()
    const { cipherText, sharedSecret } = kem.encapsulate(decodeBytes(offer.key, kem.lengths.publicKey))
    try {
      await this.#pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      await this.#pc.setLocalDescription(await this.#pc.createAnswer())
      const answer = { v: version, kem: encodeBytes(cipherText), sdp: await this.#localDescription() }
      const secret = this.#inviteSecret
      answer.tag = await signReply(secret, offer, answer)
      const cipher = await createCipher(secret, sharedSecret, offer, answer, false)
      this.#controller.signal.throwIfAborted()
      this.#cipher = cipher
      socket.send('answer', await signaling.seal('answer', answer))
      // Keep the socket until the relay forwards the answer and acknowledges it.
      await socket.receive('paired')
    } finally {
      sharedSecret.fill(0)
    }
  }

  #clearHandshake() {
    this.#inviteSecret?.fill(0)
    this.#privateKey?.fill(0)
    this.#inviteSecret = undefined
    this.#privateKey = undefined
  }

  #attach(channel) {
    this.#channel = channel
    channel.onopen = async () => {
      try {
        const transport = this.#pc.sctp?.transport?.iceTransport
        const reportRoute = () => {
          const pair = transport?.getSelectedCandidatePair?.()
          if (!pair) return
          const types = [pair.local?.type, pair.remote?.type]
          if (types.includes('relay')) this.events.route('relay')
          else if (types.every((type) => type === 'host' || type === 'srflx')) this.events.route('direct')
          else this.events.route()
        }
        transport?.addEventListener('selectedcandidatepairchange', reportRoute, { signal: this.#controller.signal })
        reportRoute()
        const proof = await this.#cipher.seal(keyProof)
        if (this.#controller.signal.aborted) return
        channel.send(proof)
        this.#confirmationSent = true
        this.#confirm()
      } catch {
        this.#fail('Could not confirm the encrypted connection.')
      }
    }
    channel.onclose = () => this.#fail('The peer disconnected. Start a new session to reconnect.')
    channel.onerror = () => this.#fail('The connection was interrupted.')
    channel.onmessage = ({ data }) => {
      if (this.#controller.signal.aborted) return
      if (typeof data !== 'string' || data.length > frameLimit || this.#pendingFrames >= 128) {
        this.#fail('The peer sent invalid session traffic.')
        return
      }
      this.#pendingFrames++
      this.#incoming = this.#incoming.then(async () => {
        if (this.#controller.signal.aborted) return
        const plaintext = await this.#cipher.open(data)
        if (this.#controller.signal.aborted) return
        if (!this.#confirmationReceived) {
          if (plaintext !== keyProof) throw new Error('Invalid key confirmation.')
          this.#confirmationReceived = true
          this.#confirm()
          return
        }
        if (typeof plaintext !== 'string' || plaintext.length > messageLimit || !plaintext.trim()) {
          throw new Error('Invalid message.')
        }
        this.events.message(plaintext, data)
      }).catch(() => this.#fail('An encrypted message could not be authenticated. The session ended.'))
        .finally(() => this.#pendingFrames--)
    }
  }

  #confirm() {
    if (!this.#confirmationSent || !this.#confirmationReceived || this.#ready) return
    this.#ready = true
    clearTimeout(this.#connectionTimer)
    this.events.ready(this.#cipher.code)
  }

  async send(text) {
    if (!this.#ready || !text.trim() || text.length > messageLimit) throw new Error('Cannot send this message.')
    if (this.#channel.bufferedAmount > 256000) throw new Error('The connection is busy. Try again in a moment.')
    try {
      const frame = await this.#cipher.seal(text)
      this.#controller.signal.throwIfAborted()
      this.#channel.send(frame)
      return frame
    } catch (error) {
      this.#fail('The encrypted message could not be sent. The session ended.')
      throw error
    }
  }

  #fail(message) {
    if (this.#controller.signal.aborted) return
    this.close()
    this.events.closed(message)
  }

  close() {
    this.#ready = false
    this.#controller.abort()
    clearTimeout(this.#connectionTimer)
    this.#clearHandshake()
    this.#cipher = undefined
    this.#channel?.close()
    this.#pc?.close()
  }
}

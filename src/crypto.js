import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

export const version = 2
export const messageLimit = 4000
export const frameLimit = 36000
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const kem = ml_kem768

export function encodeBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeBytes(value, length) {
  if (typeof value !== 'string' || value.length > frameLimit || !/^[\w-]+$/.test(value)) {
    throw new Error('Invalid encoded data.')
  }
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (byte) => byte.charCodeAt(0))
  if ((length !== undefined && bytes.length !== length) || encodeBytes(bytes) !== value) {
    throw new Error('Invalid encoded data.')
  }
  return bytes
}

export function encodeToken(value) {
  return encodeBytes(encoder.encode(JSON.stringify(value)))
}

export function decodeToken(value) {
  return JSON.parse(decoder.decode(decodeBytes(value)))
}

const utf8 = (value) => encoder.encode(JSON.stringify(value))

function transcript(offer, answer) {
  return [version, 'that-boy-needs-p2p pairing', offer.key, offer.sdp, answer.kem, answer.sdp]
}

async function authKey(inviteSecret) {
  return crypto.subtle.importKey('raw', inviteSecret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signReply(inviteSecret, offer, answer) {
  const tag = await crypto.subtle.sign('HMAC', await authKey(inviteSecret), utf8(transcript(offer, answer)))
  return encodeBytes(new Uint8Array(tag))
}

export async function verifyReply(inviteSecret, offer, answer) {
  return crypto.subtle.verify('HMAC', await authKey(inviteSecret), decodeBytes(answer.tag, 32), utf8(transcript(offer, answer)))
}

export async function createCipher(inviteSecret, sharedSecret, offer, answer, host) {
  const material = new Uint8Array(64)
  material.set(inviteSecret)
  material.set(sharedSecret, 32)
  sharedSecret.fill(0)

  let root
  try {
    root = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey', 'deriveBits'])
  } finally {
    material.fill(0)
  }
  const salt = await crypto.subtle.digest('SHA-256', utf8(transcript(offer, answer)))
  const params = (label) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(`that-boy-needs-p2p v2 ${label}`) })
  const aes = { name: 'AES-GCM', length: 256 }
  const [sendKey, receiveKey, code] = await Promise.all([
    crypto.subtle.deriveKey(params(host ? 'host to guest' : 'guest to host'), root, aes, false, ['encrypt']),
    crypto.subtle.deriveKey(params(host ? 'guest to host' : 'host to guest'), root, aes, false, ['decrypt']),
    crypto.subtle.deriveBits(params('verification code'), root, 64),
  ])

  // Each direction has its own key and strictly ordered, single-use counters.
  let sent = 0n
  let received = 0n
  function nonce(counter) {
    if (counter > 0xFFFFFFFFn) throw new Error('Session message limit reached.')
    const iv = new Uint8Array(12)
    new DataView(iv.buffer).setBigUint64(4, counter)
    return { name: 'AES-GCM', iv }
  }

  const fingerprint = Array.from(new Uint8Array(code), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    code: fingerprint.toUpperCase().match(/.{4}/g).join(' '),
    async seal(data) {
      const result = await crypto.subtle.encrypt(nonce(sent++), sendKey, utf8(data))
      return encodeBytes(new Uint8Array(result))
    },
    async open(frame) {
      const result = await crypto.subtle.decrypt(nonce(received), receiveKey, decodeBytes(frame))
      received++
      return JSON.parse(decoder.decode(result))
    },
  }
}

export async function createSignalCipher(inviteSecret, room) {
  const root = await crypto.subtle.importKey('raw', inviteSecret, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode(room),
    info: encoder.encode('that-boy-needs-p2p v2 signaling'),
  }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

  const params = (type, iv) => ({ name: 'AES-GCM', iv, additionalData: utf8([version, room, type]) })
  return {
    async seal(type, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(params(type, iv), key, utf8(value)))
      const frame = new Uint8Array(iv.length + encrypted.length)
      frame.set(iv)
      frame.set(encrypted, iv.length)
      return encodeBytes(frame)
    },
    async open(type, payload) {
      try {
        const frame = decodeBytes(payload)
        const plaintext = await crypto.subtle.decrypt(params(type, frame.subarray(0, 12)), key, frame.subarray(12))
        return JSON.parse(decoder.decode(plaintext))
      } catch {
        throw new Error('The invite could not authenticate its peer. Ask for a new link.')
      }
    },
  }
}

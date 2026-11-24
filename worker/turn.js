const credentialLifetimeSeconds = 60 * 60

export class TurnSetupError extends Error {}

export function turnConfig(env) {
  const id = env.TURN_KEY_ID?.trim()
  const token = env.TURN_API_TOKEN?.trim()
  if (!id || !token) {
    throw new TurnSetupError('Set TURN_KEY_ID and TURN_API_TOKEN from the same Cloudflare TURN Server.')
  }
  return { id, token }
}

export async function issueTurnCredentials(env) {
  const { id, token } = turnConfig(env)
  let response
  try {
    response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: credentialLifetimeSeconds }),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new TurnSetupError('Could not reach Cloudflare’s TURN credential API. Check the Worker’s Internet connection.')
  }
  if ([400, 401, 403, 404].includes(response.status)) {
    throw new TurnSetupError(`Cloudflare returned HTTP ${response.status}. Check the App ID and App Key from the same TURN Server.`)
  }
  if (!response.ok) {
    throw new TurnSetupError(`Cloudflare’s TURN credential API returned HTTP ${response.status}. Try again later.`)
  }

  const result = await response.json().catch(() => null)
  // Browsers block port 53, which otherwise delays non-trickle ICE gathering.
  const iceServers = (Array.isArray(result?.iceServers) ? result.iceServers : [])
    .filter((server) => server && typeof server === 'object')
    .map(({ urls, ...server }) => ({
      ...server,
      urls: [urls].flat().filter((url) => typeof url === 'string' && !/:53(?:\?|$)/.test(url)),
    }))
    .filter(({ urls }) => urls.length)
  if (!iceServers.some((server) =>
    typeof server.username === 'string' && server.username
    && typeof server.credential === 'string' && server.credential
    && server.urls.some((url) => /^turns?:/.test(url)))) {
    throw new TurnSetupError('Cloudflare did not return usable TURN credentials.')
  }
  return iceServers
}

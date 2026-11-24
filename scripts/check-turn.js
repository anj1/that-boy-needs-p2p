import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { issueTurnCredentials, TurnSetupError } from '../worker/turn.js'

try {
  const contents = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')
  await issueTurnCredentials(parseEnv(contents))
  console.log('Cloudflare accepted the credentials and returned usable TURN servers.')
} catch (error) {
  if (error.code === 'ENOENT') console.error('Create .dev.vars with the App ID and App Key from your Cloudflare TURN Server.')
  else console.error(error instanceof TurnSetupError ? error.message : 'Could not check the TURN credentials.')
  process.exitCode = 1
}

# That Boy Needs P2P

A two-person, end-to-end encrypted chat for peers on different networks. The left pane shows your sent messages, the middle pane shows the ciphertext exchanged over WebRTC, and the right pane shows your peer’s decrypted messages.

Select **Create invite**, share the private link with one person, and keep the tab open. Opening the link starts pairing automatically. The link expires after 10 minutes. Once connected, **Session details** shows a verification code that both people can compare over a trusted channel.

## Set up Cloudflare TURN

You need Node.js 24 or later and a Cloudflare account.

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a server. Copy these fields from that server:

   | Cloudflare dashboard | Worker setting |
   | --- | --- |
   | **App ID** (also called Token ID) | `TURN_KEY_ID` |
   | **App Key** (also called API Token) | `TURN_API_TOKEN` |

   Cloudflare’s [TURN credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/) calls this pair a TURN key. Use the pair from **TURN Server**. **Serverless SFU** has its own credentials.

2. Run `npm ci` in this repository. Wrangler is included as a development dependency.

The Worker issues each browser its own temporary TURN credentials when both peers open a session. These credentials expire after one hour. Start a fresh invite if a long-running relayed session disconnects.

## Test on your computer

Create a file named `.dev.vars` beside `wrangler.jsonc` with your actual values:

```dotenv
TURN_KEY_ID="app-id-from-turn-server"
TURN_API_TOKEN="app-key-from-turn-server"
```

Keep the file private. Git ignores it. Run this check before starting the Worker:

```sh
npm run check:turn
```

The check calls the same Cloudflare API as the Worker and prints the result without showing either key or the generated credentials. If Cloudflare returns **401**, **403**, or **404**, confirm both values came from the same **TURN Server**. If the check passes but the browser reports that it cannot reach the pairing service, make sure Wrangler is listening on port 8787 and the page’s origin is in `ALLOWED_ORIGINS`.

In one terminal, start the signaling Worker:

```sh
npm run worker:dev
```

In a second terminal, build and serve the page:

```sh
npm start
```

1. Open **http://localhost:4173** and click **Create invite**. Use this hostname and port as written, since the Worker verifies the page’s origin.
2. Copy the link into another browser window or a private window on the same computer. Wait for both pages to show **Connected**, then send a message in each direction.
3. Open **Session details** on both sides to compare the verification codes. The session status indicates whether WebRTC connected directly or through TURN when the browser exposes the selected route.

If port 4173 is busy, add your alternative origin to `ALLOWED_ORIGINS`, restart the Worker, and serve the built page with `npm run preview -- --port YOUR-PORT`.

This runs the page and Worker on your computer and uses Cloudflare for real TURN credentials and relay access. Restart the local Worker after changing the credentials. WebRTC can choose a direct route during a same-computer test. To verify the deployed app between networks, for example, use a laptop on Wi-Fi and a phone with Wi-Fi disabled. For that test, use your public GitHub Pages URL.

## Deploy the signaling Worker

1. Set `ALLOWED_ORIGINS` in [wrangler.jsonc](wrangler.jsonc) to the origin of your frontend, for example `https://YOUR-USERNAME.github.io`. An origin includes the scheme and hostname but omits the repository path and trailing slash. Add comma-separated origins if you also want to test against this Worker from localhost.
2. Run the following commands. Wrangler will prompt for each secret. Use the same values as in `.dev.vars`.

   ```sh
   npx wrangler login
   npm run worker:deploy
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_API_TOKEN
   ```

3. Copy the Worker’s HTTPS origin from the deploy output, for example `https://that-boy-needs-p2p.YOUR-SUBDOMAIN.workers.dev`. The page uses the corresponding `wss://` endpoint to pair browsers.

Wrangler creates the Durable Object binding and applies the SQLite class migration. The Worker limits pairing attempts per IP and issues credentials only after a room has two peers. This is a public, anonymous entry point. Cloudflare’s [rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are per location and approximate, so monitor TURN usage if you publish the app broadly.

## Publish the static page on GitHub Pages

1. In your GitHub repository, go to **Settings → Secrets and variables → Actions → Variables**. Create the repository variable `VITE_SIGNAL_URL` with the Worker’s HTTPS origin. This is public configuration. Keep both TURN secrets in the Worker.
2. Choose **GitHub Actions** as the source under **Settings → Pages → Build and deployment**.
3. Run **Publish GitHub Pages** from the Actions tab, or push to the default branch. The workflow publishes `dist/` and includes the license and the matching `source.tar.gz` archive. The page uses relative asset paths, so it also works under a repository subpath.

For a manual build, set `VITE_SIGNAL_URL` in an untracked `.env.local` file and run `npm run build`. Keep the frontend’s origin in the Worker's allowlist.

## How pairing and encryption work

The Cloudflare Worker exchanges two encrypted signaling packets, one offer and one answer. The invitation secret stays in the URL fragment and is removed from the address bar when the guest opens the link. The browser addresses the Worker with the room ID and keeps the invitation secret private. It accepts one host and one guest, then closes their signaling sockets after forwarding the answer. It holds temporary connection metadata and an expiry alarm. It stores no signaling packets or chat history.

WebRTC prefers a direct data connection and can use Cloudflare TURN when a direct path is unavailable. The TURN relay forwards encrypted packets and can observe connection metadata, such as IP addresses and timing. The browsers use ML-KEM-768 to establish a shared secret and AES-256-GCM to encrypt messages. Plaintext chat and private keys stay in browser memory. The application-specific pairing protocol is unaudited.

## License

[GNU General Public License, version 3](LICENSE) (`GPL-3.0-only`).

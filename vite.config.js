import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const signal = new URL(env.VITE_SIGNAL_URL || 'http://localhost:8787')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(signal.hostname)
  if (signal.href !== signal.origin + '/' || signal.username || signal.password
      || !(signal.protocol === 'https:' || (signal.protocol === 'http:' && loopback))) {
    throw new Error('VITE_SIGNAL_URL must be an HTTPS origin or a localhost HTTP origin.')
  }
  const websocketOrigin = (signal.protocol === 'https:' ? 'wss://' : 'ws://') + signal.host
  return {
    base: './',
    preview: { strictPort: true },
    define: { __SIGNAL_ORIGIN__: JSON.stringify(signal.origin) },
    plugins: [{
      name: 'signaling-content-security-policy',
      transformIndexHtml(html) {
        return html.replace("base-uri 'none'", `connect-src ${websocketOrigin}; base-uri 'none'`)
      },
    }],
  }
})

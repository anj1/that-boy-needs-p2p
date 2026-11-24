import { Compartment, EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, placeholder } from '@codemirror/view'
import { messageLimit } from './crypto.js'
import { Session } from './session.js'
import { inviteUrl, newInvite, readInvite } from './signaling.js'

const $ = (id) => document.getElementById(id)
const dialog = $('pairing')
const capability = globalThis.isSecureContext && globalThis.crypto?.subtle && typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function'
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
let current
let mode = 'idle'
let sending = false
let inviteLink = ''
let route = ''
let verificationCode = ''
const log = []
const retainedMessages = 100

const editing = new Compartment()
const editor = new EditorView({
  parent: $('editor'),
  extensions: [
    editing.of(EditorView.editable.of(false)),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Write a message', spellcheck: 'false', autocapitalize: 'off' }),
    EditorState.changeFilter.of((transaction) => transaction.newDoc.length <= messageLimit),
    placeholder('Write a message…'),
    keymap.of([{ key: 'Mod-Enter', run: () => { $('compose').requestSubmit(); return true } }]),
    EditorView.updateListener.of((update) => { if (update.docChanged) updateSend() }),
  ],
})

const wireHeaders = ViewPlugin.fromClass(class {
  constructor(view) { this.updateHeaders(view) }
  update(update) {
    if (update.docChanged || update.viewportChanged) this.updateHeaders(update.view)
  }
  updateHeaders(view) {
    const marks = []
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos)
        if (/^(SENT|RECEIVED) +·/.test(line.text)) {
          marks.push(Decoration.mark({ class: 'wire-meta' }).range(line.from, line.to))
        }
        pos = line.to + 1
      }
    }
    this.decorations = Decoration.set(marks, true)
  }
}, { decorations: (plugin) => plugin.decorations })

const wireEditor = new EditorView({
  parent: $('wire-log'),
  extensions: [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': 'Encrypted message traffic', 'aria-readonly': 'true' }),
    EditorView.theme({ '&': { fontSize: '.8125rem' }, '.cm-content': { color: '#c6d1eb' } }, { dark: true }),
    wireHeaders,
  ],
})

function updateSend() {
  $('send').disabled = mode !== 'live' || sending || !editor.state.doc.toString().trim()
}

function setMode(next) {
  const labels = {
    idle: 'Disconnected', creating: 'Preparing invite', waiting: 'Waiting for peer',
    joining: 'Joining session', connecting: 'Connecting', live: 'Connected',
  }
  const live = next === 'live'
  const notes = {
    creating: 'Opening a private invite…',
    waiting: 'Share your invite to connect.',
    joining: 'Opening the invite…',
    connecting: 'Finding a route and confirming the encryption keys…',
    live: route || 'Two peers connected.',
  }

  mode = next
  $('connection-label').textContent = labels[next]
  $('connection').dataset.state = live ? 'live' : next === 'idle' ? 'idle' : 'pending'
  $('session-bar').hidden = next === 'idle'
  $('session-note').textContent = notes[next] || ''
  $('session-details').hidden = next === 'creating' || next === 'joining'
  $('create').disabled = !capability || next !== 'idle'
  $('compose-hint').textContent = live ? 'Ctrl / ⌘ + Enter to send' : 'Waiting for a peer'
  $('incoming-title').textContent = live ? 'Connected to your peer' : 'Waiting for a peer'
  $('incoming-note').textContent = live ? 'Their messages will appear here.' : 'Connect to see their messages here.'
  editor.dispatch({ effects: editing.reconfigure(EditorView.editable.of(live)) })
  updateSend()
}

function showNotice(message = '') {
  $('notice').textContent = message
  $('notice').hidden = !message
}

function setDialog(title, note) {
  $('pair-title').textContent = title
  $('pair-note').textContent = note
  $('pair-body').replaceChildren()
  if (!dialog.open) dialog.showModal()
  return $('pair-body')
}

function copyInvite(parent) {
  const label = document.createElement('label')
  label.htmlFor = 'invite-link'
  label.textContent = 'Invite link'
  const field = document.createElement('textarea')
  field.id = 'invite-link'
  field.value = inviteLink
  field.readOnly = true
  field.spellcheck = false
  field.autocomplete = 'off'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'button secondary'
  copy.textContent = 'Copy invite'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(field.value)
      copy.textContent = 'Copied'
    } catch {
      field.focus()
      field.select()
      copy.textContent = 'Press Ctrl / ⌘ + C'
    }
  })
  parent.append(label, field, copy)
}

function openDetails() {
  if (mode === 'waiting') {
    const body = setDialog('Invite one peer', 'Share this private link and keep this tab open. The link expires after 10 minutes.')
    copyInvite(body)
  } else if (mode === 'live') {
    const body = setDialog('Verify your peer', 'Compare this code with your peer over a trusted channel. Both screens should show the same code.')
    const code = document.createElement('code')
    code.className = 'pair-code'
    code.textContent = verificationCode
    body.append(code)
  } else if (mode === 'connecting') {
    setDialog('Connecting', 'Finding a route between the two browsers and confirming the encryption keys.')
  }
}

async function prepare(invite, host) {
  if (!capability || mode !== 'idle') return
  const session = new Session({
    waiting() {
      if (current !== session) return
      inviteLink = inviteUrl(invite)
      setMode('waiting')
      if (dialog.open) openDetails()
    },
    connecting() {
      if (current !== session) return
      inviteLink = ''
      setMode('connecting')
      if (dialog.open) dialog.close()
      $('pair-body').replaceChildren()
    },
    route(kind) {
      if (current !== session) return
      route = {
        relay: 'Connected through Cloudflare TURN',
        direct: 'Connected directly to your peer',
      }[kind] || 'Two peers connected.'
      if (mode === 'live') $('session-note').textContent = route
    },
    ready(code) {
      if (current !== session) return
      verificationCode = code
      setMode('live')
      if (dialog.open) dialog.close()
      $('pair-body').replaceChildren()
      editor.focus()
    },
    message(text, frame) {
      if (current === session) addMessage('incoming', text, frame)
    },
    closed(message) {
      if (current === session) endSession(message)
    },
  })
  current = session
  showNotice()
  setMode(host ? 'creating' : 'joining')
  if (host) setDialog('Preparing invite', 'Opening a private invite.')
  try {
    await session.connect(invite, host)
  } catch (error) {
    if (current === session) endSession(error.message || 'Could not connect to the peer.')
  }
}

function clearMessages() {
  for (const direction of ['outgoing', 'incoming']) {
    const empty = $(direction + '-empty')
    $(direction).replaceChildren(empty)
    empty.hidden = false
  }
  log.length = 0
  $('wire-log').hidden = true
  $('wire-empty').hidden = false
  wireEditor.dispatch({ changes: { from: 0, to: wireEditor.state.doc.length, insert: '' } })
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } })
}

function endSession(message = '') {
  const session = current
  current = undefined
  session?.close()
  inviteLink = route = verificationCode = ''
  sending = false
  if (dialog.open) dialog.close()
  $('pair-body').replaceChildren()
  clearMessages()
  setMode('idle')
  showNotice(message)
}

function addMessage(direction, text, frame) {
  const container = $(direction)
  const follow = container.scrollHeight - container.scrollTop - container.clientHeight < 32
  $(direction + '-empty').hidden = true
  const now = new Date()
  const timestamp = timeFormat.format(now)
  const message = document.createElement('article')
  message.className = 'message'
  const body = document.createElement('p')
  body.textContent = text
  const time = document.createElement('time')
  time.dateTime = now.toISOString()
  time.textContent = timestamp
  message.append(body, time)
  container.append(message)

  $('wire-empty').hidden = true
  $('wire-log').hidden = false
  const wireScroll = wireEditor.scrollDOM
  const followWire = wireScroll.scrollHeight - wireScroll.scrollTop - wireScroll.clientHeight < 32
  const label = direction === 'outgoing' ? 'SENT' : 'RECEIVED'
  const entry = `${label}  ·  ${timestamp}\n${frame}\n\n`
  log.push({ length: entry.length, message })
  const length = wireEditor.state.doc.length
  const changes = [{ from: length, insert: entry }]
  if (log.length > retainedMessages) {
    const oldest = log.shift()
    changes.unshift({ from: 0, to: oldest.length })
    oldest.message.remove()
  }
  wireEditor.dispatch({
    changes,
    effects: followWire ? EditorView.scrollIntoView(length + entry.length - (changes.length > 1 ? changes[0].to : 0)) : [],
  })
  if (follow) container.scrollTop = container.scrollHeight
}

$('compose').addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = editor.state.doc.toString()
  const before = editor.state.doc
  if (mode !== 'live' || sending || !text.trim()) return
  const session = current
  sending = true
  updateSend()
  try {
    const frame = await session.send(text)
    if (current !== session) return
    addMessage('outgoing', text, frame)
    if (editor.state.doc === before) editor.dispatch({ changes: { from: 0, to: before.length, insert: '' } })
    showNotice()
  } catch (error) {
    if (current === session) showNotice(error.message)
  } finally {
    if (current === session) {
      sending = false
      updateSend()
      editor.focus()
    }
  }
})
$('create').addEventListener('click', () => { void prepare(newInvite(), true) })
$('session-details').addEventListener('click', openDetails)
$('end').addEventListener('click', () => endSession('The session ended.'))
$('close-dialog').addEventListener('click', () => dialog.close())
addEventListener('pagehide', () => { if (current) endSession() })

function joinFromLocation() {
  const { hash } = location
  if (!hash.startsWith('#invite=')) return
  const url = new URL(location.href)
  url.hash = ''
  history.replaceState(null, '', url)
  if (!capability) return
  if (mode !== 'idle') {
    showNotice('Open the new invite in another tab, or end this session and open it again.')
    return
  }
  try {
    void prepare(readInvite(hash), false)
  } catch (error) {
    showNotice(error.message)
  }
}

setMode('idle')
if (!capability) showNotice('Open That Boy Needs P2P in a current browser over HTTPS or localhost.')
addEventListener('hashchange', joinFromLocation)
joinFromLocation()

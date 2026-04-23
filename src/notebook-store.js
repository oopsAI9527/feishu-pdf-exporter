const NOTEBOOKS_KEY = 'notebookTargets'
const NOTEBOOK_URL_PREFIX = 'https://notebooklm.google.com/notebook/'

export function parseNotebookId(value = '') {
  const input = String(value || '').trim()
  if (!input) {
    return ''
  }

  const urlMatch = input.match(/notebooklm\.google\.com\/notebook\/([^/?#]+)/i)
  if (urlMatch) {
    return decodeURIComponent(urlMatch[1])
  }

  const idMatch = input.match(/^[a-zA-Z0-9_-]{8,}$/)
  return idMatch ? input : ''
}

export function isNotebookUrl(url = '') {
  return /^https:\/\/notebooklm\.google\.com\/notebook\/[^/?#]+/i.test(url)
}

export function notebookUrl(notebookId) {
  return `${NOTEBOOK_URL_PREFIX}${encodeURIComponent(notebookId)}`
}

function normalizeName(name, fallback = 'NotebookLM Notebook') {
  return String(name || fallback)
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*NotebookLM\s*$/i, '')
    .trim()
    .slice(0, 80) || fallback
}

async function readNotebooks() {
  const result = await chrome.storage.local.get(NOTEBOOKS_KEY)
  return Array.isArray(result[NOTEBOOKS_KEY]) ? result[NOTEBOOKS_KEY] : []
}

async function writeNotebooks(notebooks) {
  await chrome.storage.local.set({
    [NOTEBOOKS_KEY]: notebooks,
  })
}

export async function listNotebooks() {
  return (await readNotebooks()).sort((a, b) => {
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
  })
}

export async function saveNotebook({ name, notebookId, url }) {
  const parsedId = parseNotebookId(notebookId || url)
  if (!parsedId) {
    throw new Error('Notebook ID 无效。')
  }

  const now = Date.now()
  const notebooks = await readNotebooks()
  const existing = notebooks.find(item => item.notebookId === parsedId)
  const next = {
    name: normalizeName(name, parsedId),
    notebookId: parsedId,
    url: notebookUrl(parsedId),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }

  const updated = existing
    ? notebooks.map(item => (item.notebookId === parsedId ? next : item))
    : [...notebooks, next]

  await writeNotebooks(updated)
  return next
}

export async function removeNotebook(notebookId) {
  const parsedId = parseNotebookId(notebookId)
  const notebooks = await readNotebooks()
  await writeNotebooks(notebooks.filter(item => item.notebookId !== parsedId))
}

export async function getNotebook(notebookId) {
  const parsedId = parseNotebookId(notebookId)
  return (await readNotebooks()).find(item => item.notebookId === parsedId) || null
}

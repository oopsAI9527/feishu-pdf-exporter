const META_PREFIX = 'importJob:'
const DB_NAME = 'feishu-document-exporter'
const DB_VERSION = 1
const CHUNK_STORE = 'importJobChunks'
const DEFAULT_CHUNK_SIZE = 768 * 1024
const DEFAULT_TTL_MS = 30 * 60 * 1000
const MAX_PDF_BYTES = 180 * 1024 * 1024

function estimateBase64Bytes(base64 = '') {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        db.createObjectStore(CHUNK_STORE, {
          keyPath: 'key',
        })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败。'))
  })
}

async function withStore(mode, callback) {
  const db = await openDatabase()

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNK_STORE, mode)
      const store = transaction.objectStore(CHUNK_STORE)
      const result = callback(store)

      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 操作失败。'))
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 操作中止。'))
    })
  } finally {
    db.close()
  }
}

function chunkKey(jobId, index) {
  return `${jobId}:${index}`
}

async function putChunks(jobId, base64, chunkSize, chunks) {
  await withStore('readwrite', store => {
    for (let index = 0; index < chunks; index += 1) {
      store.put({
        key: chunkKey(jobId, index),
        jobId,
        index,
        value: base64.slice(index * chunkSize, (index + 1) * chunkSize),
      })
    }
  })
}

async function getStoredChunk(jobId, index) {
  return await withStore('readonly', store => {
    const request = store.get(chunkKey(jobId, index))
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        if (!request.result || typeof request.result.value !== 'string') {
          reject(new Error('导入任务分块缺失。'))
          return
        }

        resolve(request.result.value)
      }
      request.onerror = () => reject(request.error || new Error('读取导入分块失败。'))
    })
  })
}

async function deleteStoredChunks(jobId) {
  await withStore('readwrite', store => {
    const request = store.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        return
      }

      if (cursor.value?.jobId === jobId) {
        cursor.delete()
      }

      cursor.continue()
    }
  })
}

function metaKey(jobId) {
  return `${META_PREFIX}${jobId}:meta`
}

export async function createImportJob({
  filename,
  mime = 'application/pdf',
  base64,
  targetNotebookId,
  targetNotebookUrl,
  chunkSize = DEFAULT_CHUNK_SIZE,
  ttlMs = DEFAULT_TTL_MS,
}) {
  if (!base64) {
    throw new Error('导入任务缺少 PDF 数据。')
  }

  const byteSize = estimateBase64Bytes(base64)
  if (byteSize > MAX_PDF_BYTES) {
    throw new Error('PDF 超过自动导入安全上限，请下载后手动上传到 NotebookLM。')
  }

  const jobId = crypto.randomUUID()
  const chunks = Math.ceil(base64.length / chunkSize)
  const now = Date.now()
  const meta = {
    jobId,
    filename,
    mime,
    byteSize,
    base64Length: base64.length,
    chunkSize,
    chunks,
    targetNotebookId,
    targetNotebookUrl,
    createdAt: now,
    expiresAt: now + ttlMs,
  }

  try {
    await putChunks(jobId, base64, chunkSize, chunks)
    await chrome.storage.session.set({
      [metaKey(jobId)]: meta,
    })
  } catch (error) {
    await deleteStoredChunks(jobId).catch(() => {})
    throw error
  }

  return meta
}

export async function getImportJobMeta(jobId) {
  const result = await chrome.storage.session.get(metaKey(jobId))
  const meta = result[metaKey(jobId)] || null
  if (!meta) {
    return null
  }

  if (meta.expiresAt && Date.now() > meta.expiresAt) {
    await deleteImportJob(jobId)
    return null
  }

  return meta
}

export async function getImportJobChunk(jobId, index) {
  const meta = await getImportJobMeta(jobId)
  if (!meta) {
    throw new Error('导入任务已过期或不存在。')
  }

  if (!Number.isInteger(index) || index < 0 || index >= meta.chunks) {
    throw new Error('导入任务分块索引无效。')
  }

  return await getStoredChunk(jobId, index)
}

export async function deleteImportJob(jobId) {
  await chrome.storage.session.remove(metaKey(jobId))
  await deleteStoredChunks(jobId)
}

export async function cleanupExpiredJobs() {
  const all = await chrome.storage.session.get(null)
  const expiredJobIds = Object.entries(all)
    .filter(([key, value]) => key.startsWith(META_PREFIX) && value?.expiresAt && Date.now() > value.expiresAt)
    .map(([, value]) => value.jobId)

  await Promise.all(expiredJobIds.map(jobId => deleteImportJob(jobId)))
}

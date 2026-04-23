const IMPORTED_SOURCES_KEY = 'notebookImportedSources'

export function normalizeSourceName(name = '') {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function sourceKey(notebookId, sourceName) {
  return `${notebookId}::${normalizeSourceName(sourceName)}`
}

async function readImportedSources() {
  const result = await chrome.storage.local.get(IMPORTED_SOURCES_KEY)
  return Array.isArray(result[IMPORTED_SOURCES_KEY]) ? result[IMPORTED_SOURCES_KEY] : []
}

async function writeImportedSources(records) {
  await chrome.storage.local.set({
    [IMPORTED_SOURCES_KEY]: records,
  })
}

export async function listImportedSources() {
  return await readImportedSources()
}

export async function hasImportedSource(notebookId, sourceName) {
  const key = sourceKey(notebookId, sourceName)
  return (await readImportedSources()).some(record => {
    return sourceKey(record.notebookId, record.sourceName) === key
  })
}

export async function importedNotebookIdsForSource(sourceName) {
  const normalized = normalizeSourceName(sourceName)
  if (!normalized) {
    return []
  }

  return (await readImportedSources())
    .filter(record => normalizeSourceName(record.sourceName) === normalized)
    .map(record => record.notebookId)
}

export async function recordImportedSource({
  notebookId,
  notebookName,
  sourceName,
  sourceTitle,
  sourceUrl,
  byteSize = 0,
}) {
  const normalized = normalizeSourceName(sourceName)
  if (!notebookId || !normalized) {
    throw new Error('导入记录缺少 Notebook 或文档名称。')
  }

  const records = await readImportedSources()
  const key = sourceKey(notebookId, sourceName)
  const now = Date.now()
  const nextRecord = {
    notebookId,
    notebookName,
    sourceName,
    sourceTitle,
    sourceUrl,
    byteSize,
    importedAt: now,
  }

  const nextRecords = records.some(record => sourceKey(record.notebookId, record.sourceName) === key)
    ? records.map(record => (sourceKey(record.notebookId, record.sourceName) === key ? {
      ...record,
      ...nextRecord,
      importedAt: record.importedAt || now,
      updatedAt: now,
    } : record))
    : [...records, nextRecord]

  await writeImportedSources(nextRecords)
  return nextRecord
}

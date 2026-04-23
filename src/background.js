import {
  cleanupExpiredJobs,
  createImportJob,
  deleteImportJob,
  getImportJobChunk,
  getImportJobMeta,
} from './import-job-store.js'
import {
  getNotebook,
  isNotebookUrl,
  listNotebooks,
  notebookUrl,
  parseNotebookId,
  removeNotebook,
  saveNotebook,
} from './notebook-store.js'

const PROTOCOL_VERSION = '1.3'
const JOBS = new Map()
const SUPPORTED_HOST_PATTERNS = [
  /^https:\/\/[^/]+\.feishu\.cn\//,
  /^https:\/\/[^/]+\.larksuite\.com\//,
  /^https:\/\/[^/]+\.bytedance\.net\//,
]

function isSupportedUrl(url = '') {
  return SUPPORTED_HOST_PATTERNS.some(pattern => pattern.test(url))
}

function sanitizeFilename(input = 'feishu-document') {
  return input
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'feishu-document'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function ensurePageExporter(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/page-export.js'],
    world: 'MAIN',
  })
}

async function runInPage(tabId, func, args = []) {
  const [injectionResult] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args,
  })

  return injectionResult?.result ?? null
}

async function runPagePreparation(tabId) {
  return (
    (await runInPage(tabId, async () => {
      if (typeof window.__feishuPdfExporterPreparePdf !== 'function') {
        return { ok: false, error: '页面预处理脚本未加载成功。' }
      }

      return await window.__feishuPdfExporterPreparePdf()
    })) ?? { ok: false, error: '页面预处理未返回结果。' }
  )
}

async function captureStructuredDocument(tabId) {
  return (
    (await runInPage(tabId, async () => {
      if (typeof window.__feishuPdfExporterCaptureStructuredDocument !== 'function') {
        return { ok: false, error: '结构化导出脚本未加载成功。' }
      }

      return await window.__feishuPdfExporterCaptureStructuredDocument()
    })) ?? { ok: false, error: '结构化导出未返回结果。' }
  )
}

async function captureMarkdownDocument(tabId) {
  return (
    (await runInPage(tabId, async () => {
      if (typeof window.__feishuPdfExporterCaptureMarkdownDocument !== 'function') {
        return { ok: false, error: 'Markdown 导出脚本未加载成功。' }
      }

      return await window.__feishuPdfExporterCaptureMarkdownDocument()
    })) ?? { ok: false, error: 'Markdown 导出未返回结果。' }
  )
}

async function notifyPage(tabId, message, tone = 'default') {
  try {
    await runInPage(
      tabId,
      (nextMessage, nextTone) => {
        if (typeof window.__feishuPdfExporterNotify === 'function') {
          window.__feishuPdfExporterNotify(nextMessage, nextTone)
        }
      },
      [message, tone],
    )
  } catch (error) {
    console.warn('Failed to notify page', error)
  }
}

async function withDebugger(tabId, task) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, PROTOCOL_VERSION)

  try {
    await chrome.debugger.sendCommand(debuggee, 'Page.enable')
    return await task(debuggee)
  } finally {
    try {
      await chrome.debugger.detach(debuggee)
    } catch (error) {
      console.warn('Failed to detach debugger', error)
    }
  }
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const existingTab = await chrome.tabs.get(tabId)
  if (existingTab.status === 'complete') {
    return
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error('打印页加载超时。'))
    }, timeoutMs)

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return
      }

      clearTimeout(timeout)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }

    chrome.tabs.onUpdated.addListener(listener)
  })
}

async function waitForPrintPageReady(jobId, timeoutMs = 30000) {
  const job = JOBS.get(jobId)
  if (!job) {
    throw new Error('打印任务不存在。')
  }

  if (job.ready) {
    return
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      job.resolveReady = null
      job.rejectReady = null
      reject(new Error('打印页准备超时。'))
    }, timeoutMs)

    job.resolveReady = () => {
      clearTimeout(timeoutId)
      job.resolveReady = null
      job.rejectReady = null
      resolve()
    }

    job.rejectReady = error => {
      clearTimeout(timeoutId)
      job.resolveReady = null
      job.rejectReady = null
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function printTabToPdf(tabId) {
  return await withDebugger(tabId, async debuggee => {
    const result = await chrome.debugger.sendCommand(debuggee, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    })

    return result.data
  })
}

async function downloadPdf(base64, filename) {
  await chrome.downloads.download({
    url: `data:application/pdf;base64,${base64}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  })
}

async function downloadTempPdfForImport(base64, filename) {
  const downloadId = await chrome.downloads.download({
    url: `data:application/pdf;base64,${base64}`,
    filename: `Feishu NotebookLM Imports/${crypto.randomUUID()}-${filename}`,
    saveAs: false,
    conflictAction: 'uniquify',
  })

  return await waitForDownloadComplete(downloadId)
}

async function waitForDownloadComplete(downloadId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const [downloadItem] = await chrome.downloads.search({ id: downloadId })
    if (downloadItem?.state === 'complete' && downloadItem.filename) {
      return downloadItem
    }

    if (downloadItem?.state === 'interrupted') {
      throw new Error(`临时 PDF 写入失败：${downloadItem.error || 'download interrupted'}`)
    }

    await sleep(500)
  }

  throw new Error('临时 PDF 写入超时。')
}

async function cleanupTempDownload(downloadId) {
  try {
    await chrome.downloads.removeFile(downloadId)
  } catch (error) {
    console.warn('Failed to remove temporary import file', error)
  }

  try {
    await chrome.downloads.erase({ id: downloadId })
  } catch (error) {
    console.warn('Failed to erase temporary import download record', error)
  }
}

function scheduleTempDownloadCleanup(downloadId) {
  setTimeout(() => {
    cleanupTempDownload(downloadId).catch(error => {
      console.warn('Failed to cleanup temporary import download', error)
    })
  }, 120000)
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

async function downloadMarkdown(markdown, filename) {
  await chrome.downloads.download({
    url: `data:text/markdown;charset=utf-8;base64,${utf8ToBase64(markdown)}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  })
}

async function openPrintTab(jobId) {
  const url = `${chrome.runtime.getURL('src/print.html')}?job=${encodeURIComponent(jobId)}`
  return await chrome.tabs.create({
    url,
    active: false,
  })
}

async function generatePdfFromTab(tab) {
  if (!tab.id || !isSupportedUrl(tab.url)) {
    throw new Error('当前页面不是支持导出的飞书文档页。')
  }

  const tabId = tab.id
  const jobId = crypto.randomUUID()
  let printTabId = null

  await ensurePageExporter(tabId)
  await notifyPage(tabId, '正在检查飞书文档结构...')

  const preparation = await runPagePreparation(tabId)
  if (!preparation?.ok) {
    throw new Error(preparation?.error || '页面预处理失败。')
  }

  await notifyPage(tabId, '正在提取结构化正文...')
  const structured = await captureStructuredDocument(tabId)
  if (!structured?.ok || !structured?.html) {
    throw new Error(structured?.error || '结构化正文导出失败。')
  }

  JOBS.set(jobId, {
    payload: {
      title: structured.title || preparation.title || tab.title || 'feishu-document',
      html: structured.html,
    },
    ready: false,
    resolveReady: null,
    rejectReady: null,
  })

  try {
    await notifyPage(tabId, '正在装配 PDF 页面...')
    const printTab = await openPrintTab(jobId)
    printTabId = printTab.id

    if (!printTabId) {
      throw new Error('无法创建打印页面。')
    }

    await waitForTabComplete(printTabId)
    await waitForPrintPageReady(jobId)

    await notifyPage(tabId, '正在生成 PDF 文件...')
    const base64 = await printTabToPdf(printTabId)
    const title = sanitizeFilename(structured.title || preparation.title || tab.title || 'feishu-document')

    return {
      base64,
      title,
      filename: `${title}.pdf`,
    }
  } finally {
    JOBS.delete(jobId)

    if (printTabId) {
      try {
        await chrome.tabs.remove(printTabId)
      } catch (error) {
        console.warn('Failed to close print tab', error)
      }
    }
  }
}

async function exportCurrentTab(tab) {
  try {
    const pdf = await generatePdfFromTab(tab)
    await downloadPdf(pdf.base64, pdf.filename)
    await notifyPage(tab.id, `PDF 已开始下载：${pdf.filename}`, 'success')
  } catch (error) {
    console.error('Failed to export Feishu PDF', error)
    const message = error instanceof Error ? error.message : '未知错误'
    if (tab?.id) {
      await notifyPage(tab.id, `导出失败：${message}`, 'error')
    }
  }
}

async function exportMarkdownCurrentTab(tab) {
  if (!tab.id || !isSupportedUrl(tab.url)) {
    return
  }

  const tabId = tab.id

  try {
    await ensurePageExporter(tabId)
    await notifyPage(tabId, '正在检查飞书文档结构...')

    const preparation = await runPagePreparation(tabId)
    if (!preparation?.ok) {
      throw new Error(preparation?.error || '页面预处理失败。')
    }

    await notifyPage(tabId, '正在提取 Markdown 正文...')
    const markdown = await captureMarkdownDocument(tabId)
    if (!markdown?.ok || !markdown?.markdown) {
      throw new Error(markdown?.error || 'Markdown 导出失败。')
    }

    const title = sanitizeFilename(markdown.title || preparation.title || tab.title || 'feishu-document')
    const filename = `${title}.md`

    await downloadMarkdown(markdown.markdown, filename)
    await notifyPage(tabId, `Markdown 已开始下载：${filename}`, 'success')
  } catch (error) {
    console.error('Failed to export Feishu Markdown', error)
    const message = error instanceof Error ? error.message : '未知错误'
    await notifyPage(tabId, `导出失败：${message}`, 'error')
  }
}

async function getTargetTab() {
  const tabs = await chrome.tabs.query({
    lastFocusedWindow: true,
  })

  return (
    tabs.find(candidate => isSupportedUrl(candidate.url || '')) ||
    tabs.find(candidate => candidate.active) ||
    null
  )
}

async function getContextTab() {
  const tabs = await chrome.tabs.query({
    lastFocusedWindow: true,
  })
  const activeTab = tabs.find(tab => tab.active) || null

  if (activeTab && (isSupportedUrl(activeTab.url || '') || isNotebookUrl(activeTab.url || ''))) {
    return activeTab
  }

  return tabs.find(tab => isSupportedUrl(tab.url || '') || isNotebookUrl(tab.url || '')) || activeTab
}

async function getFeishuTab() {
  const tabs = await chrome.tabs.query({
    lastFocusedWindow: true,
  })

  return tabs.find(candidate => isSupportedUrl(candidate.url || '')) || null
}

async function resolveFeishuTab(sourceTabId) {
  if (sourceTabId) {
    try {
      const tab = await chrome.tabs.get(sourceTabId)
      if (tab?.id && isSupportedUrl(tab.url || '')) {
        return tab
      }
    } catch (error) {}
  }

  return await getFeishuTab()
}

async function waitForNotebookTab(tabId, targetNotebookId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  const expectedPath = `/notebook/${encodeURIComponent(targetNotebookId)}`

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete' && (tab.url || '').includes(expectedPath)) {
      return tab
    }

    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error('NotebookLM 页面加载超时。')
}

async function runNotebookImport(tabId, jobId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/notebook-importer.js'],
  })

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async nextJobId => {
      if (typeof window.__feishuNotebookImporterImportJob !== 'function') {
        return { ok: false, error: 'NotebookLM 导入脚本未加载成功。' }
      }

      try {
        return await window.__feishuNotebookImporterImportJob(nextJobId)
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'NotebookLM 导入失败。',
        }
      }
    },
    args: [jobId],
  })

  const payload = result?.result
  if (!payload?.ok) {
    throw new Error(payload?.error || 'NotebookLM 导入失败。')
  }

  return payload
}

async function prepareNotebookUploadChooser(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/notebook-importer.js'],
  })

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      if (typeof window.__feishuNotebookImporterPrepareUploadChooser !== 'function') {
        return { ok: false, error: 'NotebookLM 上传入口定位脚本未加载成功。' }
      }

      return await window.__feishuNotebookImporterPrepareUploadChooser()
    },
  })

  const payload = result?.result
  if (!payload?.ok) {
    throw new Error(payload?.error || 'NotebookLM 上传入口定位失败。')
  }

  return payload
}

async function waitForNotebookFilename(tabId, filename) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async nextFilename => {
      if (typeof window.__feishuNotebookImporterWaitForFilename !== 'function') {
        return { ok: false, error: 'NotebookLM 文件确认脚本未加载成功。' }
      }

      return await window.__feishuNotebookImporterWaitForFilename(nextFilename)
    },
    args: [filename],
  })

  return result?.result || { ok: false, error: 'NotebookLM 文件确认未返回结果。' }
}

async function waitForFileChooser(debuggee, trigger, timeoutMs = 30000) {
  await chrome.debugger.sendCommand(debuggee, 'Page.enable')
  await chrome.debugger.sendCommand(debuggee, 'DOM.enable')
  await chrome.debugger.sendCommand(debuggee, 'Page.setInterceptFileChooserDialog', {
    enabled: true,
  })

  let listener = null

  try {
    const chooser = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (listener) {
          chrome.debugger.onEvent.removeListener(listener)
        }
        reject(new Error('NotebookLM 文件选择器没有打开。'))
      }, timeoutMs)

      listener = (source, method, params) => {
        if (source.tabId !== debuggee.tabId || method !== 'Page.fileChooserOpened') {
          return
        }

        clearTimeout(timeout)
        chrome.debugger.onEvent.removeListener(listener)
        resolve(params)
      }

      chrome.debugger.onEvent.addListener(listener)
    })

    await trigger()
    return await chooser
  } finally {
    if (listener) {
      chrome.debugger.onEvent.removeListener(listener)
    }

    await chrome.debugger.sendCommand(debuggee, 'Page.setInterceptFileChooserDialog', {
      enabled: false,
    }).catch(() => {})
  }
}

async function dispatchTrustedClick(debuggee, x, y) {
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
  })
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  })
  await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  })
}

async function runNotebookFilePathImport(tabId, filePath, filename) {
  const uploadTarget = await prepareNotebookUploadChooser(tabId)

  await withDebugger(tabId, async debuggee => {
    const chooser = await waitForFileChooser(debuggee, async () => {
      await dispatchTrustedClick(debuggee, uploadTarget.x, uploadTarget.y)
    })

    if (!chooser?.backendNodeId) {
      throw new Error('NotebookLM 文件选择器没有返回可设置的 input 节点。')
    }

    await chrome.debugger.sendCommand(debuggee, 'DOM.setFileInputFiles', {
      files: [filePath],
      backendNodeId: chooser.backendNodeId,
    })
  })

  const confirmation = await waitForNotebookFilename(tabId, filename)
  if (!confirmation?.ok) {
    console.warn(confirmation?.error || 'NotebookLM file name confirmation timed out')
  }
}

async function importCurrentFeishuDocumentToNotebook(notebookId, sourceTabId = null) {
  const targetNotebookId = parseNotebookId(notebookId)
  if (!targetNotebookId) {
    throw new Error('请选择有效的 Notebook。')
  }

  const notebook = await getNotebook(targetNotebookId)
  if (!notebook) {
    throw new Error('目标 Notebook 未保存。')
  }

  const tab = await resolveFeishuTab(sourceTabId)
  if (!tab?.id) {
    throw new Error('未找到当前窗口中的飞书文档页。')
  }

  let jobMeta = null
  let tempDownload = null

  try {
    await cleanupExpiredJobs()
    await notifyPage(tab.id, `正在生成 PDF，准备导入到 ${notebook.name}...`)
    const pdf = await generatePdfFromTab(tab)

    await notifyPage(tab.id, `正在后台打开 NotebookLM：${notebook.name}...`)
    const notebookTab = await chrome.tabs.create({
      url: `${notebookUrl(notebook.notebookId)}?addSource=true`,
      active: false,
      windowId: tab.windowId,
    })

    if (!notebookTab.id) {
      throw new Error('无法打开 NotebookLM 标签页。')
    }

    await waitForNotebookTab(notebookTab.id, notebook.notebookId)

    try {
      await notifyPage(tab.id, '正在准备 NotebookLM 临时上传文件...')
      tempDownload = await downloadTempPdfForImport(pdf.base64, pdf.filename)
      await notifyPage(tab.id, '正在后台提交到 NotebookLM 上传入口...')
      await runNotebookFilePathImport(notebookTab.id, tempDownload.filename, pdf.filename)
      scheduleTempDownloadCleanup(tempDownload.id)
    } catch (nativeUploadError) {
      console.warn('Native NotebookLM upload failed, falling back to chunked import job', nativeUploadError)
      if (tempDownload?.id) {
        cleanupTempDownload(tempDownload.id).catch(() => {})
        tempDownload = null
      }

      jobMeta = await createImportJob({
        filename: pdf.filename,
        mime: 'application/pdf',
        base64: pdf.base64,
        targetNotebookId: notebook.notebookId,
        targetNotebookUrl: notebook.url,
      })
      await runNotebookImport(notebookTab.id, jobMeta.jobId)
    }

    await notifyPage(tab.id, `已在后台提交到 NotebookLM：${notebook.name}`, 'success')

    return {
      ok: true,
      notebook,
      filename: pdf.filename,
      byteSize: jobMeta?.byteSize || tempDownload?.fileSize || 0,
    }
  } catch (error) {
    if (jobMeta?.jobId) {
      await deleteImportJob(jobMeta.jobId).catch(() => {})
    }

    if (tempDownload?.id) {
      await cleanupTempDownload(tempDownload.id).catch(() => {})
    }

    const message = error instanceof Error ? error.message : '未知错误'
    await notifyPage(tab.id, `NotebookLM 导入失败：${message}`, 'error')
    throw error
  }
}

async function getPopupState() {
  const activeTab = await getContextTab()
  const url = activeTab?.url || ''
  const currentNotebookId = isNotebookUrl(url) ? parseNotebookId(url) : ''
  const notebooks = await listNotebooks()
  const savedCurrentNotebook = currentNotebookId
    ? notebooks.find(notebook => notebook.notebookId === currentNotebookId) || null
    : null

  return {
    ok: true,
    currentNotebook: currentNotebookId
      ? {
        notebookId: currentNotebookId,
        saved: Boolean(savedCurrentNotebook),
        savedName: savedCurrentNotebook?.name || '',
      }
      : null,
    activeTab: activeTab
      ? {
        id: activeTab.id,
        title: activeTab.title,
        url,
        isFeishu: isSupportedUrl(url),
        isNotebook: isNotebookUrl(url),
        notebookId: currentNotebookId,
      }
      : null,
    notebooks,
  }
}

async function exportActiveTab(format = 'pdf') {
  const tab = await getTargetTab()
  if (!tab) {
    throw new Error('未找到当前激活标签页。')
  }

  if (format === 'markdown') {
    await exportMarkdownCurrentTab(tab)
  } else {
    await exportCurrentTab(tab)
  }

  return {
    ok: true,
    format,
    tabId: tab.id,
    url: tab.url,
    title: tab.title,
  }
}

globalThis.__feishuPdfExporterDebug = {
  async exportActiveTab() {
    return await exportActiveTab('pdf')
  },
  async exportActiveTabAsMarkdown() {
    return await exportActiveTab('markdown')
  },
  async importActiveTabToNotebook(notebookId) {
    return await importCurrentFeishuDocumentToNotebook(notebookId)
  },
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_POPUP_STATE') {
    getPopupState()
      .then(result => sendResponse(result))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '未知错误',
        })
      })
    return true
  }

  if (message?.type === 'SAVE_NOTEBOOK') {
    saveNotebook(message.notebook || {})
      .then(notebook => sendResponse({ ok: true, notebook }))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '保存 Notebook 失败。',
        })
      })
    return true
  }

  if (message?.type === 'REMOVE_NOTEBOOK') {
    removeNotebook(message.notebookId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '删除 Notebook 失败。',
        })
      })
    return true
  }

  if (message?.type === 'IMPORT_TO_NOTEBOOK') {
    importCurrentFeishuDocumentToNotebook(message.notebookId, message.sourceTabId)
      .then(result => sendResponse(result))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'NotebookLM 导入失败。',
        })
      })
    return true
  }

  if (message?.type === 'GET_IMPORT_JOB_META') {
    getImportJobMeta(message.jobId)
      .then(meta => {
        if (!meta) {
          sendResponse({ ok: false, error: '导入任务已过期或不存在。' })
          return
        }

        sendResponse({ ok: true, meta })
      })
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '读取导入任务失败。',
        })
      })
    return true
  }

  if (message?.type === 'GET_IMPORT_JOB_CHUNK') {
    getImportJobChunk(message.jobId, message.index)
      .then(chunk => sendResponse({ ok: true, chunk }))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '读取导入分块失败。',
        })
      })
    return true
  }

  if (message?.type === 'DELETE_IMPORT_JOB') {
    deleteImportJob(message.jobId)
      .then(() => sendResponse({ ok: true }))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '删除导入任务失败。',
        })
      })
    return true
  }

  if (message?.type === 'EXPORT_ACTIVE_TAB') {
    exportActiveTab(message.format === 'markdown' ? 'markdown' : 'pdf')
      .then(result => sendResponse(result))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : '未知错误',
        })
      })
    return true
  }

  if (message?.type === 'GET_PRINT_JOB') {
    const job = JOBS.get(message.jobId)
    sendResponse({
      ok: true,
      payload: job?.payload || null,
    })
    return false
  }

  if (message?.type === 'DELETE_PRINT_JOB') {
    JOBS.delete(message.jobId)
    sendResponse({ ok: true })
    return false
  }

  if (message?.type === 'PRINT_PAGE_READY') {
    const job = JOBS.get(message.jobId)
    if (job) {
      job.ready = true
      job.resolveReady?.()
    }
    sendResponse({ ok: true })
    return false
  }

  if (message?.type === 'PRINT_PAGE_FAILED') {
    const job = JOBS.get(message.jobId)
    if (job) {
      job.rejectReady?.(new Error(message.error || '打印页初始化失败。'))
    }
    sendResponse({ ok: true })
    return false
  }

  return false
})

chrome.action.onClicked.addListener(exportCurrentTab)

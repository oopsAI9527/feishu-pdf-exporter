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

async function exportCurrentTab(tab) {
  if (!tab.id || !isSupportedUrl(tab.url)) {
    return
  }

  const tabId = tab.id
  const jobId = crypto.randomUUID()
  let printTabId = null

  try {
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

    await notifyPage(tabId, '正在装配 PDF 页面...')
    const printTab = await openPrintTab(jobId)
    printTabId = printTab.id

    if (!printTabId) {
      throw new Error('无法创建打印页面。')
    }

    await waitForTabComplete(printTabId)
    await waitForPrintPageReady(jobId)

    await notifyPage(tabId, '正在生成 PDF 文件...')
    const pdfBase64 = await printTabToPdf(printTabId)
    const title = sanitizeFilename(structured.title || preparation.title || tab.title || 'feishu-document')
    const filename = `${title}.pdf`

    await downloadPdf(pdfBase64, filename)
    await notifyPage(tabId, `PDF 已开始下载：${filename}`, 'success')
  } catch (error) {
    console.error('Failed to export Feishu PDF', error)
    const message = error instanceof Error ? error.message : '未知错误'
    await notifyPage(tabId, `导出失败：${message}`, 'error')
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
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

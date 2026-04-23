const statusNode = document.getElementById('status')
const buttons = Array.from(document.querySelectorAll('button'))

function setBusy(busy) {
  for (const button of buttons) {
    button.disabled = busy
  }
}

async function exportActiveTab(format) {
  setBusy(true)
  statusNode.textContent = format === 'markdown' ? '正在导出 Markdown...' : '正在导出 PDF...'

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'EXPORT_ACTIVE_TAB',
      format,
    })

    if (!result?.ok) {
      throw new Error(result?.error || '导出失败。')
    }

    statusNode.textContent = '已开始下载。'
    window.setTimeout(() => window.close(), 800)
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : '导出失败。'
  } finally {
    setBusy(false)
  }
}

document.getElementById('export-pdf').addEventListener('click', () => {
  exportActiveTab('pdf')
})

document.getElementById('export-markdown').addEventListener('click', () => {
  exportActiveTab('markdown')
})

const statusNode = document.getElementById('status')
let state = null

function setBusy(busy) {
  for (const button of document.querySelectorAll('button')) {
    button.disabled = busy
  }
}

function setStatus(message) {
  statusNode.textContent = message || ''
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }

      if (!response?.ok) {
        reject(new Error(response?.error || '操作失败。'))
        return
      }

      resolve(response)
    })
  })
}

async function exportActiveTab(format) {
  setBusy(true)
  setStatus(format === 'markdown' ? '正在导出 Markdown...' : '正在导出 PDF...')

  try {
    await sendMessage({
      type: 'EXPORT_ACTIVE_TAB',
      format,
    })

    setStatus('已开始下载。')
    window.setTimeout(() => window.close(), 800)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导出失败。')
  } finally {
    setBusy(false)
  }
}

function selectedNotebookId() {
  return document.querySelector('input[name="target-notebook"]:checked')?.value || ''
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderNotebooks(notebooks = []) {
  const list = document.getElementById('notebook-list')
  if (!notebooks.length) {
    list.className = 'hint'
    list.textContent = '还没有保存 Notebook。'
    return
  }

  list.className = ''
  const importedNotebookIds = new Set(state?.currentSource?.importedNotebookIds || [])
  const firstAvailableIndex = notebooks.findIndex(notebook => !importedNotebookIds.has(notebook.notebookId))

  list.innerHTML = notebooks.map((notebook, index) => `
    <label class="notebook-row">
      <input
        type="radio"
        name="target-notebook"
        value="${escapeHtml(notebook.notebookId)}"
        ${index === firstAvailableIndex ? 'checked' : ''}
        ${importedNotebookIds.has(notebook.notebookId) ? 'disabled' : ''}
      />
      <span title="${escapeHtml(notebook.notebookId)}">
        ${escapeHtml(notebook.name)}${importedNotebookIds.has(notebook.notebookId) ? '（已导入）' : ''}
      </span>
      <button class="danger" data-remove-notebook="${escapeHtml(notebook.notebookId)}" type="button">删除</button>
    </label>
  `).join('')

  if (firstAvailableIndex < 0 && state?.currentSource?.name) {
    list.insertAdjacentHTML(
      'beforeend',
      `<p class="hint">当前文档 ${escapeHtml(state.currentSource.name)} 已导入到所有已保存 Notebook。</p>`,
    )
  }

  for (const button of list.querySelectorAll('[data-remove-notebook]')) {
    button.addEventListener('click', async event => {
      event.preventDefault()
      event.stopPropagation()
      await removeNotebook(button.dataset.removeNotebook)
    })
  }
}

function renderState(nextState) {
  state = nextState
  const activeTab = state.activeTab
  const saveSection = document.getElementById('save-current-section')
  const exportSection = document.getElementById('export-section')
  const importSection = document.getElementById('import-section')

  saveSection.classList.toggle('hidden', !activeTab?.isNotebook)
  exportSection.classList.toggle('hidden', !activeTab?.isFeishu)
  importSection.classList.toggle('hidden', !activeTab?.isFeishu)

  if (activeTab?.isNotebook) {
    document.getElementById('current-notebook-name').value =
      (activeTab.title || '').replace(/\s*-\s*NotebookLM\s*$/i, '').trim()
  }

  renderNotebooks(state.notebooks)
}

async function refreshState() {
  renderState(await sendMessage({ type: 'GET_POPUP_STATE' }))
}

async function saveCurrentNotebook() {
  const activeTab = state?.activeTab
  if (!activeTab?.isNotebook) {
    setStatus('当前页面不是 NotebookLM notebook。')
    return
  }

  const name = document.getElementById('current-notebook-name').value
  setBusy(true)
  setStatus('正在保存当前 Notebook...')

  try {
    await sendMessage({
      type: 'SAVE_NOTEBOOK',
      notebook: {
        name,
        notebookId: activeTab.notebookId,
        url: activeTab.url,
      },
    })
    setStatus('Notebook 已保存。')
    await refreshState()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存失败。')
  } finally {
    setBusy(false)
  }
}

async function addNotebook() {
  const name = document.getElementById('manual-notebook-name').value
  const value = document.getElementById('manual-notebook-value').value

  setBusy(true)
  setStatus('正在添加 Notebook...')

  try {
    await sendMessage({
      type: 'SAVE_NOTEBOOK',
      notebook: {
        name,
        notebookId: value,
        url: value,
      },
    })
    document.getElementById('manual-notebook-name').value = ''
    document.getElementById('manual-notebook-value').value = ''
    setStatus('Notebook 已添加。')
    await refreshState()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '添加失败。')
  } finally {
    setBusy(false)
  }
}

async function removeNotebook(notebookId) {
  setBusy(true)
  setStatus('正在删除 Notebook...')

  try {
    await sendMessage({
      type: 'REMOVE_NOTEBOOK',
      notebookId,
    })
    setStatus('Notebook 已删除。')
    await refreshState()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '删除失败。')
  } finally {
    setBusy(false)
  }
}

async function importToNotebook() {
  const notebookId = selectedNotebookId()
  if (!notebookId) {
    setStatus('请先选择目标 Notebook。')
    return
  }

  setBusy(true)
  setStatus('正在生成 PDF 并导入 NotebookLM...')

  try {
    await sendMessage({
      type: 'IMPORT_TO_NOTEBOOK',
      notebookId,
      sourceTabId: state?.activeTab?.isFeishu ? state.activeTab.id : null,
    })
    setStatus('已提交到 NotebookLM。')
    window.setTimeout(() => window.close(), 1000)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '导入失败。')
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

document.getElementById('save-current-notebook').addEventListener('click', saveCurrentNotebook)
document.getElementById('add-notebook').addEventListener('click', addNotebook)
document.getElementById('import-notebook').addEventListener('click', importToNotebook)

refreshState().catch(error => {
  setStatus(error instanceof Error ? error.message : '初始化失败。')
})

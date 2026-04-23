(function () {
  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms))
  }

  function allElementsDeep(root = document) {
    const output = []
    const visit = node => {
      if (!node) {
        return
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        output.push(node)
        if (node.shadowRoot) {
          visit(node.shadowRoot)
        }
      }

      const children = node.children || []
      for (const child of children) {
        visit(child)
      }
    }

    visit(root)
    return output
  }

  function visibleText(element) {
    return [
      element.textContent || '',
      element.getAttribute?.('aria-label') || '',
      element.getAttribute?.('title') || '',
    ].join(' ').replace(/\s+/g, ' ').trim()
  }

  function findFileInput() {
    return allElementsDeep()
      .filter(element => {
        return element.tagName === 'INPUT' &&
          String(element.type || '').toLowerCase() === 'file' &&
          !element.disabled
      })
      .sort((left, right) => fileInputScore(right) - fileInputScore(left))[0] || null
  }

  function findAddSourceButton() {
    return allElementsDeep().find(element => {
      const role = element.getAttribute?.('role') || ''
      const isButton = element.tagName === 'BUTTON' || role === 'button'
      if (!isButton) {
        return false
      }

      const text = visibleText(element).toLowerCase()
      return (
        /add source|add sources|upload source|upload sources/.test(text) ||
        /添加.*来源|新增.*来源|上传.*来源|添加.*资料|新增.*资料|上传.*资料/.test(text)
      )
    }) || null
  }

  function isClickable(element) {
    const role = element.getAttribute?.('role') || ''
    return (
      element.tagName === 'BUTTON' ||
      element.tagName === 'LABEL' ||
      element.tagName === 'A' ||
      role === 'button' ||
      element.tabIndex >= 0 ||
      typeof element.onclick === 'function'
    )
  }

  function fileInputScore(input) {
    const accept = String(input.accept || '').toLowerCase()
    let score = 0

    if (accept.includes('.pdf') || accept.includes('application/pdf')) {
      score += 10
    }

    if (accept.includes('.md') || accept.includes('.docx') || accept.includes('.txt')) {
      score += 2
    }

    if (input.multiple) {
      score += 1
    }

    return score
  }

  function findUploadFileButton() {
    return allElementsDeep().find(element => {
      if (!isClickable(element)) {
        return false
      }

      const text = visibleText(element).toLowerCase()
      if (/add source|add sources|添加.*来源/.test(text)) {
        return false
      }

      return (
        /upload|choose file|choose files|browse files|from computer|local file/.test(text) ||
        /上传.*文件|文件.*上传|本地.*上传|从电脑.*上传|选择.*文件/.test(text)
      )
    }) || null
  }

  async function waitForFileInput(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs
    let clickedAddSource = false
    let clickedUploadFile = false

    while (Date.now() < deadline) {
      if (!clickedAddSource) {
        const button = findAddSourceButton()
        if (button) {
          button.click()
          clickedAddSource = true
          await sleep(500)
        }
      }

      if (clickedAddSource && !clickedUploadFile) {
        const uploadButton = findUploadFileButton()
        if (uploadButton) {
          uploadButton.click()
          clickedUploadFile = true
          await sleep(800)
        }
      }

      const input = findFileInput()
      if (input && (clickedUploadFile || !findUploadFileButton())) {
        return input
      }

      await sleep(500)
    }

    return null
  }

  async function openUploadChooser(timeoutMs = 45000) {
    const target = await prepareUploadChooser(timeoutMs)
    if (!target.ok) {
      return target
    }

    const element = document.elementFromPoint(target.x, target.y)
    element?.click()

    return {
      ok: true,
      label: target.label,
    }
  }

  async function prepareUploadChooser(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs
    let clickedAddSource = false

    while (Date.now() < deadline) {
      if (!clickedAddSource) {
        const addButton = findAddSourceButton()
        if (addButton) {
          addButton.click()
          clickedAddSource = true
          await sleep(700)
        }
      }

      const uploadButton = findUploadFileButton()
      if (uploadButton) {
        uploadButton.scrollIntoView({
          block: 'center',
          inline: 'center',
        })
        await sleep(150)

        const rect = uploadButton.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          await sleep(500)
          continue
        }

        const label = visibleText(uploadButton)
        return {
          ok: true,
          label,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        }
      }

      await sleep(500)
    }

    return {
      ok: false,
      error: '没有找到 NotebookLM 上传文件入口。',
    }
  }

  async function waitForFilename(filename, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    const normalizedFilename = String(filename || '').trim()
    const stem = normalizedFilename.replace(/\.[^.]+$/, '')

    while (Date.now() < deadline) {
      const pageText = visibleText(document.documentElement)
      if (
        (normalizedFilename && pageText.includes(normalizedFilename)) ||
        (stem && stem.length > 8 && pageText.includes(stem))
      ) {
        return { ok: true }
      }

      await sleep(500)
    }

    return {
      ok: false,
      error: '已设置上传文件，但未在 NotebookLM 页面确认到文件名。',
    }
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
          reject(new Error(response?.error || 'NotebookLM 导入通信失败。'))
          return
        }

        resolve(response)
      })
    })
  }

  function base64ToBytes(base64) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return bytes
  }

  async function readJobFile(jobId) {
    const metaResponse = await sendMessage({
      type: 'GET_IMPORT_JOB_META',
      jobId,
    })
    const meta = metaResponse.meta
    const parts = []
    let receivedLength = 0

    for (let index = 0; index < meta.chunks; index += 1) {
      const chunkResponse = await sendMessage({
        type: 'GET_IMPORT_JOB_CHUNK',
        jobId,
        index,
      })
      receivedLength += chunkResponse.chunk.length
      parts.push(base64ToBytes(chunkResponse.chunk))
    }

    if (receivedLength !== meta.base64Length) {
      throw new Error('导入任务数据不完整。')
    }

    const blob = new Blob(parts, {
      type: meta.mime || 'application/pdf',
    })

    return {
      meta,
      file: new File([blob], meta.filename || 'feishu-document.pdf', {
        type: meta.mime || 'application/pdf',
      }),
    }
  }

  function setFileInput(input, file) {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    input.files = dataTransfer.files
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  async function importJob(jobId) {
    const { meta, file } = await readJobFile(jobId)
    const expectedPath = `/notebook/${encodeURIComponent(meta.targetNotebookId)}`

    if (!window.location.pathname.includes(expectedPath)) {
      throw new Error('当前 NotebookLM 页面不是目标 notebook。')
    }

    const input = await waitForFileInput()
    if (!input) {
      throw new Error('没有找到 NotebookLM 文件上传控件。')
    }

    setFileInput(input, file)

    await sendMessage({
      type: 'DELETE_IMPORT_JOB',
      jobId,
    })

    return {
      ok: true,
      filename: file.name,
      byteSize: meta.byteSize,
    }
  }

  window.__feishuNotebookImporterImportJob = importJob
  window.__feishuNotebookImporterOpenUploadChooser = openUploadChooser
  window.__feishuNotebookImporterPrepareUploadChooser = prepareUploadChooser
  window.__feishuNotebookImporterWaitForFilename = waitForFilename
})()

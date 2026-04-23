(async function () {
  const params = new URLSearchParams(window.location.search)
  const jobId = params.get('job')
  const statusNode = document.getElementById('status')
  const shellNode = document.getElementById('snapshot-shell')

  function markReady(ready) {
    document.documentElement.dataset.feishuPdfExporterReady = ready ? 'true' : 'false'
  }

  async function waitForImages(root) {
    const images = Array.from(root.querySelectorAll('img'))
    if (images.length === 0) {
      return
    }

    await Promise.all(
      images.map(img => new Promise(resolve => {
        if (img.complete && img.naturalWidth > 0) {
          resolve()
          return
        }

        const done = () => resolve()
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
        window.setTimeout(done, 5000)
      })),
    )
  }

  try {
    if (!jobId) {
      throw new Error('缺少打印任务 ID。')
    }

    markReady(false)
    const result = await chrome.runtime.sendMessage({
      type: 'GET_PRINT_JOB',
      jobId,
    })
    const payload = result?.payload

    if (!payload?.html) {
      throw new Error('未找到结构化打印数据。')
    }

    document.title = payload.title || 'Feishu PDF'
    shellNode.innerHTML = `<article class="text-document">${payload.html}</article>`
    shellNode.classList.add('ready')
    statusNode.style.display = 'none'

    await waitForImages(shellNode)
    await chrome.runtime.sendMessage({
      type: 'PRINT_PAGE_READY',
      jobId,
    })
    await chrome.runtime.sendMessage({
      type: 'DELETE_PRINT_JOB',
      jobId,
    })
    markReady(true)
  } catch (error) {
    markReady(false)
    await chrome.runtime.sendMessage({
      type: 'PRINT_PAGE_FAILED',
      jobId,
      error: error instanceof Error ? error.message : '打印页初始化失败。',
    })
    statusNode.textContent = error instanceof Error ? error.message : '打印页初始化失败。'
  }
})()

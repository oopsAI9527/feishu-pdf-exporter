(function () {
  const TOAST_ID = '__feishu_pdf_exporter_toast__'

  function sleep(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms))
  }

  function getPageMain() {
    return window.PageMain
  }

  function getRootBlock() {
    const pageMain = getPageMain()
    return (
      pageMain?.blockManager?.rootBlockModel ||
      pageMain?.blockManager?.model?.rootBlockModel ||
      null
    )
  }

  function getScrollContainer() {
    return document.querySelector('#mainBox .bear-web-x-container')
  }

  function getEditorRoot() {
    return document.querySelector('#mainBox .bear-web-x-container .page-main .page-main-item.editor')
  }

  function sanitizeTitle(title = '') {
    return title
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, ' ')
      .trim()
  }

  function getPageTitle() {
    const rootBlock = getRootBlock()
    const blockTitle = sanitizeTitle(rootBlock?.zoneState?.allText || '')
    if (blockTitle) {
      return blockTitle
    }

    const documentTitle = sanitizeTitle(
      document.title.replace(/\s*-\s*飞书云文档\s*$/, ''),
    )

    return documentTitle || '飞书文档'
  }

  function escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function normalizeText(value = '') {
    return String(value)
      .replace(/\u200b/g, '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function blockText(block) {
    return normalizeText(block?.zoneState?.allText || '')
  }

  function blockChildren(block) {
    if (block?.type === 'synced_reference' && block?.innerBlockManager?.rootBlockModel?.children) {
      return block.innerBlockManager.rootBlockModel.children
    }

    return block?.children || []
  }

  function flattenBlocks(blocks = []) {
    const output = []

    for (const block of blocks) {
      if (!block) {
        continue
      }

      if (block.type === 'grid') {
        output.push(...flattenBlocks(blockChildren(block).flatMap(column => blockChildren(column))))
        continue
      }

      if (block.type === 'synced_source') {
        output.push(...flattenBlocks(blockChildren(block)))
        continue
      }

      if (block.type === 'synced_reference') {
        output.push(...flattenBlocks(blockChildren(block)))
        continue
      }

      output.push(block)
    }

    return output
  }

  function renderInlineText(text) {
    if (!text) {
      return ''
    }

    return escapeHtml(text).replace(/\n/g, '<br />')
  }

  function markdownText(text) {
    return normalizeText(text)
  }

  function escapeMarkdownAlt(text) {
    return markdownText(text)
      .replace(/\\/g, '\\\\')
      .replace(/]/g, '\\]')
      .replace(/\n+/g, ' ')
  }

  function indentMarkdown(markdown, prefix = '  ') {
    return markdown
      .trimEnd()
      .split('\n')
      .map(line => (line ? `${prefix}${line}` : line))
      .join('\n')
  }

  function fencedCode(text) {
    const fence = text.includes('```') ? '~~~' : '```'
    return `${fence}\n${text}\n${fence}`
  }

  function captionText(caption) {
    const attributedTexts = caption?.text?.initialAttributedTexts
    if (!attributedTexts) {
      return ''
    }

    if (Array.isArray(attributedTexts)) {
      return normalizeText(
        attributedTexts
          .map(item => item?.text?.[0] || '')
          .filter(Boolean)
          .join(' '),
      )
    }

    return normalizeText(attributedTexts?.text?.[0] || '')
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('读取图片失败。'))
      reader.readAsDataURL(blob)
    })
  }

  async function fetchImageSources(block) {
    const image = block?.snapshot?.image
    const manager = block?.imageManager

    if (!image?.token || !manager?.fetch) {
      return null
    }

    return await new Promise(resolve => {
      let settled = false
      const done = value => {
        if (!settled) {
          settled = true
          resolve(value || null)
        }
      }

      try {
        const maybePromise = manager.fetch(
          {
            token: image.token,
            isHD: true,
            fuzzy: false,
            width: image.width,
            height: image.height,
          },
          {},
          sources => done(sources),
        )

        if (maybePromise?.then) {
          maybePromise.catch(() => done(null))
        }
      } catch (error) {
        done(null)
      }

      window.setTimeout(() => done(null), 8000)
    })
  }

  async function fetchImageDataUrl(block) {
    const sources = await fetchImageSources(block)
    const src = sources?.originSrc || sources?.src
    if (!src) {
      return null
    }

    try {
      const response = await fetch(src, {
        credentials: 'include',
      })

      if (!response.ok) {
        return src
      }

      return await blobToDataUrl(await response.blob())
    } catch (error) {
      return src
    }
  }

  async function renderImageBlock(block) {
    const image = block?.snapshot?.image || {}
    const label = captionText(image.caption) || normalizeText(image.name || '') || '图片'
    const src = await fetchImageDataUrl(block)

    if (!src) {
      return `<figure class="feishu-image"><div class="feishu-image-placeholder">[${escapeHtml(label)}]</div></figure>`
    }

    const width = Number.isFinite(image.width) ? Math.max(1, Math.round(image.width)) : null
    const height = Number.isFinite(image.height) ? Math.max(1, Math.round(image.height)) : null
    const dimensions = width && height ? ` width="${width}" height="${height}"` : ''

    return `<figure class="feishu-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(label)}"${dimensions} /></figure>`
  }

  async function renderImageMarkdown(block) {
    const image = block?.snapshot?.image || {}
    const label = captionText(image.caption) || normalizeText(image.name || '') || '图片'
    const src = await fetchImageDataUrl(block)

    if (!src) {
      return `[图片：${markdownText(label)}]`
    }

    return `![${escapeMarkdownAlt(label)}](${src})`
  }

  function renderUnsupportedBlock(block, label) {
    const text = blockText(block)
    const body = text ? `：${escapeHtml(text)}` : ''
    return `<p class="feishu-note">[${escapeHtml(label)}${body}]</p>`
  }

  async function renderList(blocks, ordered, startIndex = 0) {
    const tag = ordered ? 'ol' : 'ul'
    let index = startIndex
    let html = `<${tag}>`

    while (index < blocks.length) {
      const block = blocks[index]
      const matches =
        ordered
          ? block.type === 'ordered'
          : block.type === 'bullet' || block.type === 'todo'

      if (!matches) {
        break
      }

      const text = blockText(block)
      const childrenHtml = await renderBlocks(blockChildren(block))
      const todoPrefix =
        block.type === 'todo'
          ? block?.snapshot?.done
            ? '[x] '
            : '[ ] '
          : ''

      html += `<li>${renderInlineText(todoPrefix + text)}${childrenHtml}</li>`
      index += 1
    }

    html += `</${tag}>`

    return {
      html,
      nextIndex: index,
    }
  }

  async function renderBlocks(blocks = []) {
    const flattened = flattenBlocks(blocks)
    let html = ''

    for (let index = 0; index < flattened.length; ) {
      const block = flattened[index]

      if (!block) {
        index += 1
        continue
      }

      if (block.type === 'bullet' || block.type === 'todo') {
        const list = await renderList(flattened, false, index)
        html += list.html
        index = list.nextIndex
        continue
      }

      if (block.type === 'ordered') {
        const list = await renderList(flattened, true, index)
        html += list.html
        index = list.nextIndex
        continue
      }

      const text = blockText(block)

      switch (block.type) {
        case 'heading1':
        case 'heading2':
        case 'heading3':
        case 'heading4':
        case 'heading5':
        case 'heading6': {
          const depth = Number(block.type.slice(-1))
          html += `<h${depth}>${renderInlineText(text)}</h${depth}>`
          break
        }
        case 'text': {
          if (text) {
            html += `<p>${renderInlineText(text)}</p>`
          }
          break
        }
        case 'callout':
        case 'quote_container': {
          const inner = await renderBlocks(blockChildren(block))
          if (inner) {
            html += `<blockquote>${inner}</blockquote>`
          }
          break
        }
        case 'code': {
          html += `<pre><code>${escapeHtml(text)}</code></pre>`
          break
        }
        case 'divider': {
          html += '<hr />'
          break
        }
        case 'image': {
          html += await renderImageBlock(block)
          break
        }
        case 'table':
        case 'grid': {
          html += renderUnsupportedBlock(block, block.type === 'table' ? '表格' : '分栏')
          break
        }
        case 'file': {
          html += renderUnsupportedBlock(block, '附件')
          break
        }
        case 'iframe': {
          html += renderUnsupportedBlock(block, '嵌入内容')
          break
        }
        case 'whiteboard':
        case 'diagram':
        case 'isv': {
          html += renderUnsupportedBlock(block, '图形内容')
          break
        }
        default: {
          if (text) {
            html += `<p>${renderInlineText(text)}</p>`
          }
          break
        }
      }

      index += 1
    }

    return html
  }

  async function renderMarkdownList(blocks, ordered, startIndex = 0, depth = 0) {
    let index = startIndex
    let markdown = ''
    let listNumber = 1

    while (index < blocks.length) {
      const block = blocks[index]
      const matches =
        ordered
          ? block.type === 'ordered'
          : block.type === 'bullet' || block.type === 'todo'

      if (!matches) {
        break
      }

      const text = markdownText(blockText(block))
      const marker = ordered ? `${listNumber}. ` : '- '
      const todoPrefix =
        block.type === 'todo'
          ? block?.snapshot?.done
            ? '[x] '
            : '[ ] '
          : ''
      const childMarkdown = await renderMarkdownBlocks(blockChildren(block), depth + 1)

      markdown += `${marker}${todoPrefix}${text}`.trimEnd()

      if (childMarkdown.trim()) {
        markdown += `\n${indentMarkdown(childMarkdown)}`
      }

      markdown += '\n'
      index += 1
      listNumber += 1
    }

    return {
      markdown: `${markdown}\n`,
      nextIndex: index,
    }
  }

  async function renderMarkdownBlocks(blocks = [], depth = 0) {
    const flattened = flattenBlocks(blocks)
    let markdown = ''

    for (let index = 0; index < flattened.length; ) {
      const block = flattened[index]

      if (!block) {
        index += 1
        continue
      }

      if (block.type === 'bullet' || block.type === 'todo') {
        const list = await renderMarkdownList(flattened, false, index, depth)
        markdown += list.markdown
        index = list.nextIndex
        continue
      }

      if (block.type === 'ordered') {
        const list = await renderMarkdownList(flattened, true, index, depth)
        markdown += list.markdown
        index = list.nextIndex
        continue
      }

      const text = markdownText(blockText(block))

      switch (block.type) {
        case 'heading1':
        case 'heading2':
        case 'heading3':
        case 'heading4':
        case 'heading5':
        case 'heading6': {
          const headingDepth = Number(block.type.slice(-1))
          markdown += `${'#'.repeat(headingDepth)} ${text}\n\n`
          break
        }
        case 'text': {
          if (text) {
            markdown += `${text}\n\n`
          }
          break
        }
        case 'callout':
        case 'quote_container': {
          const inner = await renderMarkdownBlocks(blockChildren(block), depth + 1)
          if (inner.trim()) {
            markdown += `${inner.trimEnd().split('\n').map(line => `> ${line}`).join('\n')}\n\n`
          }
          break
        }
        case 'code': {
          markdown += `${fencedCode(text)}\n\n`
          break
        }
        case 'divider': {
          markdown += '---\n\n'
          break
        }
        case 'image': {
          markdown += `${await renderImageMarkdown(block)}\n\n`
          break
        }
        case 'table':
        case 'grid': {
          markdown += `[${block.type === 'table' ? '表格' : '分栏'}${text ? `：${text}` : ''}]\n\n`
          break
        }
        case 'file': {
          markdown += `[附件${text ? `：${text}` : ''}]\n\n`
          break
        }
        case 'iframe': {
          markdown += `[嵌入内容${text ? `：${text}` : ''}]\n\n`
          break
        }
        case 'whiteboard':
        case 'diagram':
        case 'isv': {
          markdown += `[图形内容${text ? `：${text}` : ''}]\n\n`
          break
        }
        default: {
          if (text) {
            markdown += `${text}\n\n`
          }
          break
        }
      }

      index += 1
    }

    return markdown
  }

  function ensureToast() {
    let toast = document.getElementById(TOAST_ID)
    if (toast) {
      return toast
    }

    toast = document.createElement('div')
    toast.id = TOAST_ID
    toast.style.cssText = [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:2147483647',
      'max-width:360px',
      'padding:12px 14px',
      'border-radius:10px',
      'background:rgba(17,24,39,.92)',
      'color:#fff',
      'font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.25)',
      'display:none',
      'white-space:pre-wrap',
    ].join(';')

    document.documentElement.appendChild(toast)
    return toast
  }

  function showToast(message, tone = 'default', timeout = 3000) {
    const toast = ensureToast()
    toast.textContent = message
    toast.style.display = 'block'
    toast.style.background =
      tone === 'error'
        ? 'rgba(127,29,29,.96)'
        : tone === 'success'
          ? 'rgba(22,101,52,.96)'
          : 'rgba(17,24,39,.92)'

    window.clearTimeout(showToast.timer)
    showToast.timer = window.setTimeout(() => {
      toast.style.display = 'none'
    }, timeout)
  }
  showToast.timer = 0

  function isSupportedFeishuDocPage() {
    const path = window.location.pathname || ''
    return /\/(wiki|docx)\//.test(path) && !!getPageMain()
  }

  function isReady() {
    const rootBlock = getRootBlock()
    if (!rootBlock?.children?.length) {
      return false
    }

    return rootBlock.children.every(block => {
      const snapshotReady = block?.snapshot?.type !== 'pending'
      const syncedReady = block?.type !== 'synced_reference' || block.isAllDataReady
      return snapshotReady && syncedReady
    })
  }

  async function waitForPageShell(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (getPageMain() && getRootBlock() && getScrollContainer() && getEditorRoot()) {
        return true
      }

      await sleep(250)
    }

    return false
  }

  async function preparePdf() {
    showToast('正在检测飞书文档结构...')

    const shellReady = await waitForPageShell()
    if (!shellReady) {
      return { ok: false, error: '页面核心结构未加载出来，请稍后重试。' }
    }

    if (!isSupportedFeishuDocPage()) {
      return { ok: false, error: '当前页面不是支持导出的飞书文档页。' }
    }

    if (!isReady()) {
      return { ok: false, error: '文档仍有区块在懒加载，暂时无法保证完整导出。' }
    }

    return {
      ok: true,
      title: getPageTitle(),
    }
  }

  async function captureStructuredDocument() {
    const rootBlock = getRootBlock()
    if (!rootBlock) {
      return { ok: false, error: '未找到飞书文档结构化数据。' }
    }

    showToast('正在从飞书结构化数据生成文本 PDF...', 'default', 15000)
    const title = getPageTitle()
    const bodyHtml = await renderBlocks(blockChildren(rootBlock))
    const html = `<h1>${renderInlineText(title)}</h1>${bodyHtml}`
    if (!bodyHtml) {
      return { ok: false, error: '结构化文档渲染结果为空。' }
    }

    return {
      ok: true,
      title,
      html,
    }
  }

  async function captureMarkdownDocument() {
    const rootBlock = getRootBlock()
    if (!rootBlock) {
      return { ok: false, error: '未找到飞书文档结构化数据。' }
    }

    showToast('正在从飞书结构化数据生成 Markdown...', 'default', 15000)
    const title = getPageTitle()
    const bodyMarkdown = await renderMarkdownBlocks(blockChildren(rootBlock))
    const markdown = `# ${markdownText(title)}\n\n${bodyMarkdown}`.trimEnd() + '\n'
    if (!bodyMarkdown.trim()) {
      return { ok: false, error: '结构化文档渲染结果为空。' }
    }

    return {
      ok: true,
      title,
      markdown,
    }
  }

  window.__feishuPdfExporterPreparePdf = preparePdf
  window.__feishuPdfExporterCaptureStructuredDocument = captureStructuredDocument
  window.__feishuPdfExporterCaptureMarkdownDocument = captureMarkdownDocument
  window.__feishuPdfExporterNotify = showToast
})()

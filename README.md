# Feishu Document Exporter

Chrome 扩展，用于把飞书文档直接导出成完整 PDF 或单文件 Markdown，方便喂给 NotebookLM。

## Features

- 直接复用飞书页面运行时：`window.PageMain`、`rootBlockModel`、`#mainBox .bear-web-x-container`
- 直接读取飞书 `rootBlockModel`，生成结构化正文 HTML 或 Markdown
- 图片块通过飞书 `imageManager` 拉取原图；PDF 内嵌图片，Markdown 使用 `data:image/...;base64` 内嵌图片
- 使用 Chrome DevTools `Page.printToPDF` 直接生成 PDF，不走系统打印对话框
- 自动下载单个 `.pdf` 或 `.md` 文件，不生成压缩包
- 支持 `feishu.cn`、`larksuite.com`、`bytedance.net`

## Installation

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder

## Usage

1. Open a Feishu document page
2. 等页面基础内容加载出来
3. 点击扩展图标
4. 选择 `导出 PDF` 或 `导出 Markdown（内嵌图片）`
5. 扩展会自动等待内容加载、生成文件、并直接开始下载

## Technical Notes

- 页内预处理逻辑参考 `cloud-document-converter` 对 Feishu `docx` 页的识别方式
- `src/page-export.js` 运行在页面主世界，用来判断文档是否就绪，并从 `rootBlockModel` 生成结构化 HTML/Markdown
- `src/print.html` + `src/print.js` 负责渲染结构化 HTML，避免直接打印飞书原页面时被其固定布局污染
- `src/background.js` 负责调度结构化导出、打开打印页、调用 `chrome.debugger` 的 `Page.printToPDF`，或直接下载 Markdown
- 文件下载由 `chrome.downloads.download()` 完成

## Local Self-Test

浏览器已用 `--remote-debugging-port=9222` 启动时，可以直接运行：

```bash
npm run test:direct-pdf
npm run test:markdown
```

脚本会连接当前打开的飞书页面，执行与扩展同一套结构化导出流程，再输出测试产物到 `artifacts/`。

## Current Limits

- 本版依赖飞书 `PageMain.rootBlockModel`，如果飞书后续改掉内部模型，需要同步调整适配层
- 极端复杂自定义块可能会降级成文本占位
- 图片下载依赖当前登录态和飞书图片接口权限
- Markdown 内嵌 base64 图片是单文件方案，但 NotebookLM 对 Markdown data URI 图片的识别效果需要按实际导入结果确认；PDF 是更稳的图片保真方案

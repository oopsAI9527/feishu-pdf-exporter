# Feishu Document Exporter

Chrome extension for exporting readable Feishu/Lark documents as clean PDF or single-file Markdown, with an optional NotebookLM import flow.

## Features

- Export the current Feishu document to a single `.pdf` file.
- Export the current Feishu document to a single `.md` file with images embedded as `data:image/...;base64`.
- Save multiple NotebookLM notebook targets by URL or notebook ID.
- Import the current Feishu document as PDF into a selected NotebookLM notebook.
- Prevent importing the same generated PDF name into the same saved notebook more than once.
- Keep Feishu extraction, PDF/Markdown export, and NotebookLM import as separate modules.

## How It Works

- `src/page-export.js` runs in the Feishu page main world and reads `window.PageMain.blockManager.rootBlockModel`.
- `src/print.html` and `src/print.js` render a clean PDF page before `Page.printToPDF`.
- `src/notebook-store.js` stores NotebookLM target names and IDs in `chrome.storage.local`.
- `src/import-history-store.js` records which generated PDF names have already been submitted to each notebook.
- `src/import-job-store.js` stores large temporary PDF import jobs in chunks using extension IndexedDB plus `chrome.storage.session` metadata.
- `src/notebook-importer.js` runs inside NotebookLM and locates the upload entry; the background worker uses Chrome Debugger/CDP to set the generated PDF on the native file chooser.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository folder.

No build step is required.

## Use

### Export PDF or Markdown

1. Open a readable Feishu `wiki` or `docx` page.
2. Click the extension icon.
3. Choose `导出 PDF` or `导出 Markdown（内嵌图片）`.

### Save a NotebookLM Target

Option A:

1. Open a NotebookLM notebook page, for example `https://notebooklm.google.com/notebook/<id>`.
2. Click the extension icon.
3. Enter a display name, then click `保存当前 Notebook`.

Option B:

1. Click the extension icon on any supported page.
2. Use `手动添加 Notebook`.
3. Enter a display name and a NotebookLM URL or notebook ID.

### Import Feishu Document to NotebookLM

1. Open the Feishu document page.
2. Click the extension icon.
3. Select the target notebook.
4. Click `导入当前飞书 PDF 到选中 Notebook`.

The extension generates a PDF first, writes a temporary import PDF, opens the selected NotebookLM notebook in a background tab, and submits the PDF through NotebookLM's native upload flow. If the native file chooser route fails, it falls back to the chunked in-memory import job.

## Limits

- NotebookLM upload automation depends on the current NotebookLM web UI. If the upload DOM changes, the fallback is to export PDF and upload manually.
- The extension confirms that the PDF has been submitted to the NotebookLM upload input, not that NotebookLM has finished indexing it.
- Very large PDFs above the safety threshold are not auto-imported; export and upload manually instead.
- Complex Feishu custom blocks may degrade to text placeholders.

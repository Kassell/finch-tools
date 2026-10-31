import { DatabaseSync } from 'node:sqlite';
import { extname } from 'node:path';
const db = new DatabaseSync('E:\\knowledge\\.knowledge\\catalog.sqlite', { readOnly: true });
try {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='index_failures'").get();
  if (!exists) { console.log(JSON.stringify({ failureMetadataAvailable: false })); }
  else {
    const rows = db.prepare('SELECT path, reason FROM index_failures').all();
    const classify = text => {
      if (/No extractable text/i.test(text)) return 'no-extractable-text';
      if (/Unsupported file type/i.test(text)) return 'unsupported-file-type';
      if (/nonempty.*smaller than/i.test(text)) return 'empty-or-size-limit';
      if (/empty file|file.*empty/i.test(text)) return 'empty-file';
      if (/smaller than|too large|size limit|exceeds.*bytes/i.test(text)) return 'file-size-limit';
      if (/ENOENT|not found|does not exist/i.test(text)) return 'missing-source-or-engine';
      if (/EACCES|EPERM|permission denied/i.test(text)) return 'access-denied';
      if (/timeout|timed out/i.test(text)) return 'extraction-timeout';
      if (/PDF.*password|encrypted|password.protected/i.test(text)) return 'encrypted-document';
      if (/OCR|paddle/i.test(text)) return 'ocr-error';
      if (/anydoc|parse|convert|corrupt|invalid.*(document|file|format)/i.test(text)) return 'document-parser-error';
      return 'other-processing-error';
    };
    console.log(JSON.stringify({ failureMetadataAvailable: true, count: rows.length,
      failures: rows.map(row => ({ extension: extname(row.path).toLowerCase(), category: classify(row.reason),
        needsTextLayer: /text layer|scanned PDF/i.test(row.reason) })) }, null, 2));
  }
} finally { db.close(); }

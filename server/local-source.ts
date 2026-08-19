import path from 'node:path';

const MAX_LOCAL_SOURCE_NAME_LENGTH = 180;

export const LOCAL_PDF_EXTENSIONS = new Set(['.pdf']);
export const LOCAL_TEXT_EXTENSIONS = new Set(['.txt']);
export const LOCAL_TIMED_SOURCE_EXTENSIONS = new Set([
  '.vtt', '.srt',
  '.mp3', '.mp4', '.m4a', '.wav', '.webm', '.mov', '.mkv', '.ogg', '.opus', '.flac'
]);

const LOCAL_SOURCE_EXTENSIONS = new Set([
  ...LOCAL_PDF_EXTENSIONS,
  ...LOCAL_TEXT_EXTENSIONS,
  ...LOCAL_TIMED_SOURCE_EXTENSIONS
]);

export type ValidatedLocalSource = {
  fileName: string;
  extension: string;
};

function normalizeExtension(extension: string): string {
  const normalized = extension.startsWith('.') ? extension.toLocaleLowerCase('und') : `.${extension.toLocaleLowerCase('und')}`;
  if (!LOCAL_SOURCE_EXTENSIONS.has(normalized)) throw new Error('本地来源文件类型不受支持。');
  return normalized;
}

/**
 * Turns an untrusted upload name into a display-safe basename. Both POSIX and
 * Windows separators are handled even when the server runs on another OS.
 */
export function cleanLocalFileName(fileName: string): string {
  const withoutControls = String(fileName).replace(/[\u0000-\u001f\u007f]+/gu, '_');
  const basename = path.win32.basename(path.posix.basename(withoutControls)).trim();
  if (!basename || basename === '.' || basename === '..') throw new Error('本地文件名无效。');
  return basename.slice(0, MAX_LOCAL_SOURCE_NAME_LENGTH);
}

/**
 * Builds an opaque, non-dereferenceable identity for an already-parsed local
 * Buffer. The canonical extension describes the successful parser, rather
 * than trusting a possibly missing or mismatched upload extension.
 */
export function buildLocalSourceIdentity(fileName: string, canonicalExtension: string): string {
  const extension = normalizeExtension(canonicalExtension);
  const cleaned = cleanLocalFileName(fileName);
  const originalExtension = path.extname(cleaned);
  let stem = cleaned.slice(0, cleaned.length - originalExtension.length).trim();
  if (!stem || stem === '.' || stem === '..') stem = 'local-file';
  // Percent-like names could acquire path semantics after repeated decoding;
  // replace the literal marker before encoding to keep one canonical spelling.
  stem = stem.replace(/%/gu, '_').slice(0, MAX_LOCAL_SOURCE_NAME_LENGTH - extension.length);
  const canonicalName = `${stem}${extension}`;
  return `file:///${encodeURIComponent(canonicalName)}`;
}

/**
 * Validates the exact identity shape produced above. The returned filename is
 * metadata only: callers must never pass it (or the URI) to filesystem APIs.
 */
export function validateLocalSourceIdentity(value: string): ValidatedLocalSource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('虚拟本地来源 URL 无效。');
  }
  if (url.protocol !== 'file:' || !value.startsWith('file:///')) {
    throw new Error('虚拟本地来源必须使用 file:/// 单文件标识。');
  }
  if (url.hostname || url.username || url.password || url.port) {
    throw new Error('虚拟本地来源不得包含主机、端口或凭据。');
  }
  if (value.includes('?') || value.includes('#') || url.search || url.hash) {
    throw new Error('虚拟本地来源不得包含查询或片段。');
  }

  const encodedFileName = value.slice('file:///'.length);
  if (!encodedFileName || encodedFileName.includes('/') || encodedFileName.includes('\\')) {
    throw new Error('虚拟本地来源只能包含一个文件名段。');
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(encodedFileName);
  } catch {
    throw new Error('虚拟本地来源文件名编码无效。');
  }
  if (
    !fileName
    || fileName.length > MAX_LOCAL_SOURCE_NAME_LENGTH
    || fileName.trim() !== fileName
    || fileName === '.'
    || fileName === '..'
    || /[\u0000-\u001f\u007f/%\\]/u.test(fileName)
    || path.posix.basename(fileName) !== fileName
    || path.win32.basename(fileName) !== fileName
  ) {
    throw new Error('虚拟本地来源不是安全单文件 basename。');
  }
  if (encodeURIComponent(fileName) !== encodedFileName || url.href !== value) {
    throw new Error('虚拟本地来源必须使用规范化编码。');
  }

  const extension = path.extname(fileName).toLocaleLowerCase('und');
  if (!LOCAL_SOURCE_EXTENSIONS.has(extension)) throw new Error('虚拟本地来源文件类型不受支持。');
  return { fileName, extension };
}

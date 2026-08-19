import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ingestTranscriptBuffer } from './ingestion.js';
import { buildLocalSourceIdentity, cleanLocalFileName } from './local-source.js';
import type { KnowledgeResult } from '../shared/types.js';

const execFileAsync = promisify(execFile);
const MAX_MEDIA_BYTES = 250 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.mov', '.mkv', '.ogg', '.opus', '.flac']);

export type MediaTranscriptionDependencies = {
  executeWhisper?: (command: string, args: string[]) => Promise<void>;
};

type MediaBufferInput = {
  buffer: Buffer;
  fileName: string;
  language?: string;
  model?: string;
  observedAt?: string;
};

let activeTranscriptions = 0;

function maximumConcurrentTranscriptions(): number {
  const configured = Number(process.env.PAGE2KNOWLEDGE_MAX_TRANSCRIPTIONS ?? 1);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 4 ? configured : 1;
}

export class MediaTranscriptionError extends Error {
  constructor(public readonly code: string, message: string, public readonly suggestion: string) {
    super(message);
    this.name = 'MediaTranscriptionError';
  }
}

async function transcribeMediaBufferUnlocked(
  input: MediaBufferInput,
  dependencies: MediaTranscriptionDependencies
): Promise<KnowledgeResult> {
  let safeFileName: string;
  try {
    safeFileName = cleanLocalFileName(input.fileName);
  } catch {
    throw new MediaTranscriptionError('INVALID_FILE_NAME', '音视频文件名无效。', '请选择带有效文件名的本地音视频。');
  }
  const extension = path.extname(safeFileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new MediaTranscriptionError('UNSUPPORTED_MEDIA', '不支持该音视频格式。', '请选择常见音频或视频文件。');
  }
  if (!input.buffer.length || input.buffer.length > MAX_MEDIA_BYTES) {
    throw new MediaTranscriptionError('MEDIA_SIZE_LIMIT', '音视频为空或超过 250 MB 本地限制。', '请压缩或拆分文件后重试。');
  }
  const whisperCommand = process.env.PAGE2KNOWLEDGE_WHISPER_BIN || 'whisper';
  const model = input.model || process.env.PAGE2KNOWLEDGE_WHISPER_MODEL || 'small';
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'page2knowledge-media-'));
  const safeStem = `media-${crypto.randomUUID()}`;
  const mediaPath = path.join(temporaryRoot, `${safeStem}${extension}`);
  try {
    await fs.writeFile(mediaPath, input.buffer, { mode: 0o600 });
    const args = [mediaPath, '--model', model, '--device', 'cpu', '--output_dir', temporaryRoot, '--output_format', 'vtt', '--verbose', 'False', '--fp16', 'False'];
    if (input.language?.trim()) args.push('--language', input.language.trim());
    try {
      if (dependencies.executeWhisper) await dependencies.executeWhisper(whisperCommand, args);
      else await execFileAsync(whisperCommand, args, { timeout: 30 * 60 * 1_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new MediaTranscriptionError('WHISPER_NOT_INSTALLED', '本机未安装 Whisper 转录工具。', '安装 openai-whisper 并确保 whisper 命令可用，或先导入 VTT/SRT。');
      }
      throw new MediaTranscriptionError('TRANSCRIPTION_FAILED', '本地语音识别失败。', '请确认媒体可解码、Whisper 模型可用，或改为导入 VTT/SRT。');
    }
    const vttPath = path.join(temporaryRoot, `${safeStem}.vtt`);
    const transcript = await fs.readFile(vttPath);
    const result = ingestTranscriptBuffer({
      buffer: transcript,
      fileName: `${path.basename(safeFileName, path.extname(safeFileName))}.vtt`,
      mimeType: 'text/vtt',
      observedAt: input.observedAt
    });
    const mediaSourceUrl = buildLocalSourceIdentity(safeFileName, extension);
    result.snapshot.requestedUrl = mediaSourceUrl;
    result.snapshot.finalUrl = mediaSourceUrl;
    result.snapshot.contentLength = input.buffer.length;
    result.snapshot.contentType = extension === '.mp4' || extension === '.mov' || extension === '.mkv' || extension === '.webm'
      ? `video/${extension.slice(1)}`
      : `audio/${extension.slice(1)}`;
    result.chunks.forEach((chunk) => { chunk.source.url = mediaSourceUrl; });
    result.keyFacts.forEach((fact) => { fact.source.url = mediaSourceUrl; });
    result.sourceKind = 'transcript';
    result.warnings.unshift({
      code: 'LOCAL_SPEECH_RECOGNITION',
      message: `转录由本机 Whisper ${model} 模型生成，可能存在识别错误；引用前请回听原媒体。`
    });
    return result;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function transcribeMediaBuffer(
  input: MediaBufferInput,
  dependencies: MediaTranscriptionDependencies = {}
): Promise<KnowledgeResult> {
  if (activeTranscriptions >= maximumConcurrentTranscriptions()) {
    throw new MediaTranscriptionError(
      'TRANSCRIPTION_BUSY',
      '本机已有音视频转录任务正在运行。',
      '请等待当前任务完成后重试；默认只允许一个高内存转录任务。'
    );
  }
  activeTranscriptions += 1;
  try {
    return await transcribeMediaBufferUnlocked(input, dependencies);
  } finally {
    activeTranscriptions -= 1;
  }
}

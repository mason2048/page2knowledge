import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeMediaBuffer } from '../server/media.js';

afterEach(() => {
  delete process.env.PAGE2KNOWLEDGE_WHISPER_BIN;
});

describe('本地音视频转录边界', () => {
  it('拒绝不支持的媒体扩展名', async () => {
    await expect(transcribeMediaBuffer({
      buffer: Buffer.from('not media'),
      fileName: 'recording.exe'
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });

  it('拒绝空媒体', async () => {
    await expect(transcribeMediaBuffer({
      buffer: Buffer.alloc(0),
      fileName: 'empty.mp3'
    })).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT' });
  });

  it('缺少 Whisper 时返回可操作错误且不上传外部服务', async () => {
    process.env.PAGE2KNOWLEDGE_WHISPER_BIN = '/definitely-missing/page2knowledge-whisper';
    await expect(transcribeMediaBuffer({
      buffer: Buffer.from('fake media body'),
      fileName: 'recording.mp4'
    })).rejects.toMatchObject({
      code: 'WHISPER_NOT_INSTALLED',
      suggestion: expect.stringContaining('VTT/SRT')
    });
  });

  it('成功转录后引用原媒体文件和时间码，而不是临时 VTT', async () => {
    const executeWhisper = vi.fn(async (_command: string, args: string[]) => {
      const outputDirectory = args[args.indexOf('--output_dir') + 1];
      const mediaPath = args[0];
      const outputPath = path.join(outputDirectory, `${path.basename(mediaPath, path.extname(mediaPath))}.vtt`);
      await fs.writeFile(outputPath, 'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n访问令牌必须始终保存在服务端安全存储中。\n');
    });

    const result = await transcribeMediaBuffer({
      buffer: Buffer.from('fixed local media bytes'),
      fileName: 'private recording.mp4',
      language: 'zh'
    }, { executeWhisper });

    expect(executeWhisper).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      sourceKind: 'transcript',
      snapshot: {
        requestedUrl: 'file:///private%20recording.mp4',
        finalUrl: 'file:///private%20recording.mp4',
        contentType: 'video/mp4',
        contentLength: Buffer.byteLength('fixed local media bytes')
      }
    });
    expect(result.chunks[0].source).toEqual({
      url: 'file:///private%20recording.mp4',
      locator: 'media:t=00:00:00.000-00:00:03.000'
    });
    expect(result.keyFacts).toEqual([]);
  });

  it('跨平台清理 Windows 路径和控制字符，并生成可索引的规范媒体 identity', async () => {
    const executeWhisper = vi.fn(async (_command: string, args: string[]) => {
      const outputDirectory = args[args.indexOf('--output_dir') + 1];
      const mediaPath = args[0];
      await fs.writeFile(
        path.join(outputDirectory, `${path.basename(mediaPath, path.extname(mediaPath))}.vtt`),
        'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n媒体来源名称不会携带客户端目录结构。\n'
      );
    });

    const result = await transcribeMediaBuffer({
      buffer: Buffer.from('fixed media'),
      fileName: 'C:\\private\\records\\security\nreview.MP4'
    }, { executeWhisper });

    expect(result.snapshot.finalUrl).toBe('file:///security_review.mp4');
    expect(result.chunks[0].source.url).toBe('file:///security_review.mp4');
  });

  it('默认只允许一个高开销 Whisper 任务，并在完成后释放名额', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const executeWhisper = vi.fn(async (_command: string, args: string[]) => {
      await gate;
      const outputDirectory = args[args.indexOf('--output_dir') + 1];
      const mediaPath = args[0];
      await fs.writeFile(
        path.join(outputDirectory, `${path.basename(mediaPath, path.extname(mediaPath))}.vtt`),
        'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n并发任务完成后释放名额。\n'
      );
    });
    const input = { buffer: Buffer.from('media'), fileName: 'busy.mp3' };
    const first = transcribeMediaBuffer(input, { executeWhisper });
    await vi.waitFor(() => expect(executeWhisper).toHaveBeenCalledTimes(1));

    await expect(transcribeMediaBuffer(input, { executeWhisper })).rejects.toMatchObject({ code: 'TRANSCRIPTION_BUSY' });
    finish();
    await expect(first).resolves.toMatchObject({ sourceKind: 'transcript' });
    await expect(transcribeMediaBuffer(input, { executeWhisper })).resolves.toMatchObject({ sourceKind: 'transcript' });
  });
});

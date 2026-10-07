// Bilibili 播放器字幕数据访问：页内带凭据请求当前视频的字幕轨道与字幕内容。
// 仅处理用户正在观看视频的当前字幕，不做批量拉取与整片缓存。

import type { SubtitleCue } from '../youtube/timedtext';

export interface BiliSubtitleTrack {
  lan: string;
  lanDoc?: string;
  url: string;
}

export interface BiliPlayerSubtitles {
  tracks: BiliSubtitleTrack[];
  needLogin: boolean;
}

export interface BiliSubtitleFetchDeps {
  fetchText(url: string): Promise<string>;
}

// 读取当前视频的可用字幕轨道；未登录时站内 AI 字幕不可用（needLogin=true）。
export async function fetchBiliSubtitleTracks(deps: BiliSubtitleFetchDeps, aid: string, cid: string): Promise<BiliPlayerSubtitles> {
  const body = await deps.fetchText(`https://api.bilibili.com/x/player/wbi/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}`);
  let parsed: {
    code?: number;
    data?: {
      subtitle?: {
        subtitles?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }>;
        need_login_subtitle?: boolean;
      };
    };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('字幕接口响应无效');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('字幕接口响应无效');
  const subtitle = parsed.data?.subtitle;
  const rawTracks = Array.isArray(subtitle?.subtitles) ? subtitle.subtitles : [];
  const tracks = rawTracks
    .filter((track) => typeof track.subtitle_url === 'string' && track.subtitle_url && typeof track.lan === 'string')
    .map((track) => ({
      lan: track.lan as string,
      ...(track.lan_doc ? { lanDoc: track.lan_doc } : {}),
      // 站内返回 http 地址，统一升级 https 以匹配页面安全上下文。
      url: (track.subtitle_url as string).replace(/^http:\/\//u, 'https://'),
    }));
  return { tracks, needLogin: Boolean(subtitle?.need_login_subtitle) };
}

// 拉取字幕内容并转换为标准 cue（from/to 秒，content 文本）。
export async function fetchBiliSubtitleCues(deps: BiliSubtitleFetchDeps, url: string): Promise<SubtitleCue[]> {
  const body = await deps.fetchText(url);
  let parsed: { body?: Array<{ from?: number; to?: number; content?: string }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('字幕内容响应无效');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.body)) throw new Error('字幕内容响应无效');
  return parsed.body
    .filter((line) => typeof line.content === 'string' && line.content.trim())
    .map((line) => ({
      start: Number(line.from ?? 0),
      end: Math.max(Number(line.to ?? 0), Number(line.from ?? 0) + 0.2),
      text: (line.content as string).replace(/\s+/gu, ' ').trim(),
    }))
    .filter((cue) => cue.text.length > 0);
}

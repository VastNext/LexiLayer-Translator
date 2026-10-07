// 生词本联动：把字幕点词结果写入后台生词本管线（save-vocabulary-entry，内容脚本来源）。
// 字段长度按生词本校验上限截断，避免长句写入被整条拒绝。

export interface SubtitleVocabDraft {
  word: string;
  sentence: string;
  translation?: string;
  targetLanguage: string;
}

export type VocabularySend = (message: unknown) => Promise<unknown>;

export async function saveWordToVocabulary(
  send: VocabularySend,
  entry: SubtitleVocabDraft,
  context: { sourceUrl: string; pageTitle?: string },
): Promise<'created' | 'duplicate'> {
  const draft = {
    word: entry.word.trim().slice(0, 120),
    sentence: entry.sentence.trim().slice(0, 600),
    ...(entry.translation?.trim() ? { translation: entry.translation.trim().slice(0, 600) } : {}),
    sourceUrl: context.sourceUrl,
    ...(context.pageTitle?.trim() ? { pageTitle: context.pageTitle.trim().slice(0, 300) } : {}),
    targetLanguage: entry.targetLanguage,
  };
  const response = await send({ type: 'save-vocabulary-entry', draft }) as
    { ok?: boolean; data?: { status?: 'created' | 'duplicate' }; error?: string } | undefined;
  if (!response?.ok || !response.data?.status) throw new Error(response?.error ?? '加入生词本失败');
  return response.data.status;
}

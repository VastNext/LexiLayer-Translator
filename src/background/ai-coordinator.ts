import { orderTranslationResults } from './batching';
import { createCacheKey } from './cache';
import type { Provider } from './provider';
import type { TranslationRequest, TranslationResult, TranslationSegment } from '../shared/messages';

/**
 * 自定义 AI 请求成本计数（仅本地内存数字）。
 * 不记录正文、API Key 或 URL；providerCharacters 是本地字符自报计数，不是 provider 侧 token 实测。
 */
export interface AiRequestCostSnapshot {
  /** 段级缓存命中次数 */
  cacheHits: number;
  /** 段级缓存未命中次数（含随后被 inflight 去重的段） */
  cacheMisses: number;
  /** 通过 inflight 复用既有请求、未新增 provider 负载的段数 */
  deduplicatedSegments: number;
  /** provider.translate 批次调用次数 */
  providerCalls: number;
  /** 实际发送给 provider 的段数 */
  providerSegments: number;
  /** 实际发送给 provider 的字符数（本地自报计数，非 token 实测） */
  providerCharacters: number;
  /** 因全部订阅者取消而中止的 provider 批次数 */
  abortedBatches: number;
}

export interface AiCacheLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface AiRequestCoordinatorOptions {
  cache: AiCacheLike;
  /** 合批收集窗口毫秒数，默认 100 */
  windowMs?: number;
  /** 单批最大段数，默认 8 */
  maxSegments?: number;
  /** 单批最大字符数，默认 6000 */
  maxCharacters?: number;
  /** 参与缓存键的提示词版本，默认 '1' */
  promptVersion?: string;
  /** 可注入的定时调度，默认 setTimeout；返回取消函数 */
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}

interface QueueItem { key: string; segment: TranslationSegment }

/** 单个完整缓存键对应的在途请求，可被多个调用者订阅 */
interface Flight {
  key: string;
  segment: TranslationSegment;
  /** 派发批次内的唯一槽位 id（batchId:index），避免跨调用者原 id 重复导致错误映射 */
  slot: string | undefined;
  /** 所属排队队列，用于派发前全部取消时清理队列项 */
  queue: Queue | undefined;
  subscribers: number;
  batch: Batch | undefined;
  settled: boolean;
  resolve(text: string): void;
  reject(error: unknown): void;
  promise: Promise<string>;
}

/** 一次 provider.translate 调用对应的批次 */
interface Batch {
  controller: AbortController;
  flights: Flight[];
  subscribers: number;
  /** provider 结果已返回（或已整体失败），此后中止无意义 */
  finished: boolean;
}

interface Queue {
  identity: string;
  provider: Provider;
  request: Pick<TranslationRequest, 'sourceLanguage' | 'targetLanguage' | 'userInstruction' | 'expertId'>;
  items: QueueItem[];
  cancelTimer: (() => void) | undefined;
}

function createFlight(key: string, segment: TranslationSegment): Flight {
  let resolve!: (text: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => undefined); // 无订阅者等待时抑制未处理拒绝，等待者仍会收到结果
  return { key, segment, slot: undefined, queue: undefined, subscribers: 0, batch: undefined, settled: false, resolve, reject, promise };
}

/**
 * 自定义 AI 页面翻译协调器：
 * 缓存命中直出 → 未命中按完整缓存键 inflight 去重 → 剩余段落按 100ms 窗口合批（≤8 段 / 6000 字符）→ 单批调用 provider。
 * 不同 provider/cacheIdentity/语言/指令通过完整缓存键天然隔离；取消按订阅隔离，仅当批次所有订阅者都取消时才中止底层请求。
 * 批次对 provider 使用批内唯一槽位 id，返回后映射回各调用者原始段 id。
 */
export class AiRequestCoordinator {
  private readonly cache: AiCacheLike;
  private readonly windowMs: number;
  private readonly maxSegments: number;
  private readonly maxCharacters: number;
  private readonly promptVersion: string;
  private readonly schedule: (callback: () => void, milliseconds: number) => () => void;
  private readonly inflight = new Map<string, Flight>();
  private readonly queues = new Map<string, Queue>();
  private batchCounter = 0;
  private readonly counts: AiRequestCostSnapshot = {
    cacheHits: 0, cacheMisses: 0, deduplicatedSegments: 0,
    providerCalls: 0, providerSegments: 0, providerCharacters: 0, abortedBatches: 0,
  };

  constructor(options: AiRequestCoordinatorOptions) {
    this.cache = options.cache;
    this.windowMs = options.windowMs ?? 100;
    this.maxSegments = options.maxSegments ?? 8;
    this.maxCharacters = options.maxCharacters ?? 6000;
    this.promptVersion = options.promptVersion ?? '1';
    this.schedule = options.schedule ?? ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  }

  snapshot(): AiRequestCostSnapshot {
    return { ...this.counts };
  }

  reset(): void {
    for (const key of Object.keys(this.counts) as Array<keyof AiRequestCostSnapshot>) this.counts[key] = 0;
  }

  async translate(provider: Provider, request: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult[]> {
    if (signal?.aborted) throw new Error('任务已取消');
    // 同一请求内重复 id 会在结果映射时互相覆盖；跨调用者的相同 id 由批内槽位机制处理，不受影响
    if (new Set(request.segments.map((segment) => segment.id)).size !== request.segments.length) {
      throw new Error('翻译段 ID 重复');
    }

    let settled = false;
    let resolveAll!: (value: TranslationResult[]) => void;
    let rejectAll!: (error: unknown) => void;
    const completion = new Promise<TranslationResult[]>((resolve, reject) => { resolveAll = resolve; rejectAll = reject; });
    const finish = {
      resolve: (value: TranslationResult[]) => { if (!settled) { settled = true; resolveAll(value); } },
      reject: (error: unknown) => { if (!settled) { settled = true; rejectAll(error); } },
    };

    const flights: Flight[] = [];
    const onAbort = () => {
      for (const flight of flights) this.release(flight);
      finish.reject(new Error('任务已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const direct: TranslationResult[] = [];
    const pending: Promise<TranslationResult>[] = [];
    void (async () => {
      try {
        for (const segment of request.segments) {
          if (settled) return;
          const key = await createCacheKey({
            text: segment.text,
            sourceLanguage: request.sourceLanguage,
            targetLanguage: request.targetLanguage,
            ...provider.cacheIdentity,
            promptVersion: this.promptVersion,
            effectiveInstruction: request.userInstruction ?? '',
          });
          if (settled) return;
          const cached = await this.cache.get(key).catch(() => undefined);
          if (settled) return;
          if (cached !== undefined) {
            this.counts.cacheHits += 1;
            direct.push({ id: segment.id, text: cached });
            continue;
          }
          this.counts.cacheMisses += 1;
          let flight: Flight;
          if (this.inflight.has(key)) {
            this.counts.deduplicatedSegments += 1;
            flight = this.subscribe(this.inflight.get(key)!);
          } else {
            flight = this.enqueue(provider, request, key, segment);
          }
          flights.push(flight);
          const result = flight.promise.then((text) => ({ id: segment.id, text }));
          // 后续缓存查询可能尚未完成，先接住拒绝，最终由 allSettled 分发。
          void result.catch(() => undefined);
          pending.push(result);
        }
        // 任一在途失败不丢弃其余成功段：收集全部成功项，仅当无任何成功段时才按首个错误拒绝
        const outcomes = await Promise.allSettled(pending);
        signal?.removeEventListener('abort', onAbort);
        const fulfilled: TranslationResult[] = [];
        let firstError: { reason: unknown } | undefined;
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') fulfilled.push(outcome.value);
          else if (!firstError) firstError = { reason: outcome.reason };
        }
        if (fulfilled.length > 0 || direct.length > 0 || pending.length === 0) {
          finish.resolve(orderTranslationResults(request.segments, [...direct, ...fulfilled]));
        } else {
          finish.reject(firstError?.reason);
        }
      } catch (error) {
        signal?.removeEventListener('abort', onAbort);
        for (const flight of flights) this.release(flight);
        finish.reject(error);
      }
    })();

    return completion;
  }

  private identityOf(provider: Provider, request: TranslationRequest): string {
    return JSON.stringify([
      provider.cacheIdentity.engineId,
      provider.cacheIdentity.engineFingerprint,
      provider.cacheIdentity.adapterVersion,
      request.sourceLanguage,
      request.targetLanguage,
      request.userInstruction ?? '',
      request.expertId ?? '',
      this.promptVersion,
    ]);
  }

  /** 订阅既有在途请求（调用者自己的取消仍由外层 signal 统一退订） */
  private subscribe(flight: Flight): Flight {
    flight.subscribers += 1;
    if (flight.batch) flight.batch.subscribers += 1;
    return flight;
  }

  /** 创建在途请求并入队；入队者即首个订阅者，保证满批同步 flush 时不会因无订阅被误取消 */
  private enqueue(provider: Provider, request: TranslationRequest, key: string, segment: TranslationSegment): Flight {
    const identity = this.identityOf(provider, request);
    let queue = this.queues.get(identity);
    if (!queue) {
      queue = {
        identity,
        provider,
        request: {
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          userInstruction: request.userInstruction,
          expertId: request.expertId,
        },
        items: [],
        cancelTimer: undefined,
      };
      this.queues.set(identity, queue);
    }
    const flight = createFlight(key, segment);
    flight.subscribers = 1;
    flight.queue = queue;
    this.inflight.set(key, flight);
    queue.items.push({ key, segment });
    const characters = queue.items.reduce((sum, item) => sum + item.segment.text.length, 0);
    if (queue.items.length >= this.maxSegments || characters >= this.maxCharacters) {
      this.flush(queue);
    } else if (queue.cancelTimer === undefined) {
      queue.cancelTimer = this.schedule(() => { queue.cancelTimer = undefined; this.flush(queue); }, this.windowMs);
    }
    return flight;
  }

  private flush(queue: Queue): void {
    queue.cancelTimer?.();
    queue.cancelTimer = undefined;
    while (queue.items.length > 0) {
      const chunk: QueueItem[] = [];
      let characters = 0;
      while (queue.items.length > 0) {
        const item = queue.items[0];
        if (item.segment.text.length > this.maxCharacters) {
          queue.items.shift();
          const flight = this.inflight.get(item.key);
          if (flight) this.settleRejection(flight, new Error(`段落 ${item.segment.id} 超过单段字符上限 ${this.maxCharacters}`));
          continue;
        }
        if (chunk.length >= this.maxSegments || characters + item.segment.text.length > this.maxCharacters) break;
        chunk.push(queue.items.shift()!);
        characters += item.segment.text.length;
      }
      if (chunk.length > 0) this.dispatch(queue, chunk);
    }
    // 队列排空即释放，避免永久保留 provider（含密钥引用）与指令；身份复现时会重建
    if (queue.items.length === 0) this.queues.delete(queue.identity);
  }

  private dispatch(queue: Queue, chunk: QueueItem[]): void {
    const flights: Flight[] = [];
    for (const item of chunk) {
      const flight = this.inflight.get(item.key);
      if (!flight || flight.settled) continue;
      if (flight.subscribers <= 0) {
        // 所有订阅者在发出前已取消
        this.settleRejection(flight, new Error('任务已取消'));
        continue;
      }
      flights.push(flight);
    }
    if (flights.length === 0) return;

    this.counts.providerCalls += 1;
    this.counts.providerSegments += flights.length;
    this.counts.providerCharacters += flights.reduce((sum, flight) => sum + flight.segment.text.length, 0);

    // 批内槽位 id 全局唯一：不同调用者可能使用相同原 id，映射必须经由槽位反向还原
    const batchId = `b${this.batchCounter += 1}`;
    const controller = new AbortController();
    const batch: Batch = {
      controller,
      flights,
      subscribers: flights.reduce((sum, flight) => sum + flight.subscribers, 0),
      finished: false,
    };
    const sentSegments: TranslationSegment[] = flights.map((flight, index) => {
      flight.slot = `${batchId}:${index}`;
      flight.batch = batch;
      return { id: flight.slot, text: flight.segment.text };
    });

    const settleFrom = (results: TranslationResult[]) => {
      batch.finished = true;
      const byId = new Map(results.map((result) => [result.id, result.text]));
      for (const flight of flights) {
        const text = flight.slot === undefined ? undefined : byId.get(flight.slot);
        if (text === undefined) this.settleRejection(flight, new Error('翻译响应 ID 不匹配'));
        else void this.resolveFlight(flight, text);
      }
    };
    const failBatch = (error: unknown) => {
      batch.finished = true;
      for (const flight of flights) this.settleRejection(flight, error);
    };

    // provider 同步抛出时也走同一路径安全清理，不中断 flush 剩余批次
    let providerOutcome: Promise<TranslationResult[]>;
    try {
      providerOutcome = queue.provider.translate({
        sourceLanguage: queue.request.sourceLanguage,
        targetLanguage: queue.request.targetLanguage,
        segments: sentSegments,
        userInstruction: queue.request.userInstruction,
        ...(queue.request.expertId !== undefined ? { expertId: queue.request.expertId } : {}),
      }, controller.signal);
    } catch (error) {
      providerOutcome = Promise.reject(error);
    }
    void providerOutcome.then(settleFrom, failBatch);
  }

  /** 退订：派发前无人等待即清理在途项；派发后仅当批次所有订阅者都取消时才中止底层请求 */
  private release(flight: Flight): void {
    if (flight.settled) return;
    flight.subscribers = Math.max(0, flight.subscribers - 1);
    if (flight.batch) {
      flight.batch.subscribers = Math.max(0, flight.batch.subscribers - 1);
      if (flight.batch.subscribers === 0) this.abortBatch(flight.batch);
      return;
    }
    if (flight.subscribers > 0 || !flight.queue) return;
    // 尚未派发且无人等待：立即清理，防止旧队列项指向过期在途请求或被同键重试意外复用
    this.settleRejection(flight, new Error('任务已取消'));
    const queue = flight.queue;
    const index = queue.items.findIndex((item) => item.key === flight.key);
    if (index >= 0) queue.items.splice(index, 1);
    if (queue.items.length === 0) {
      queue.cancelTimer?.();
      queue.cancelTimer = undefined;
      this.queues.delete(queue.identity);
    }
  }

  private abortBatch(batch: Batch): void {
    // provider 结果已返回后再中止无意义，也不计入 abortedBatches
    if (batch.finished || batch.controller.signal.aborted) return;
    batch.controller.abort();
    this.counts.abortedBatches += 1;
    for (const flight of batch.flights) this.settleRejection(flight, new Error('任务已取消'));
  }

  /** 成功结果先完成缓存写入，再释放在途键：保证缓存挂起窗口内同键请求继续去重而非重复调用 */
  private async resolveFlight(flight: Flight, text: string): Promise<void> {
    if (flight.settled) return;
    try {
      await this.cache.set(flight.key, text);
    } catch {
      // 缓存写失败按 miss 语义：不阻塞调用者，后续请求重新翻译
    }
    if (flight.settled) return;
    flight.settled = true;
    this.inflight.delete(flight.key);
    flight.resolve(text);
  }

  private settleRejection(flight: Flight, error: unknown): void {
    if (flight.settled) return;
    flight.settled = true;
    this.inflight.delete(flight.key);
    flight.reject(error);
  }
}

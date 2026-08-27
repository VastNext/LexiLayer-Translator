export interface SseParseResult {
  chunks: string[];
  done: boolean;
  fallback: boolean;
}

export class SseParser {
  private buffer = '';
  private accumulated = '';
  private previousWasCarriageReturn = false;

  get content(): string {
    return this.accumulated;
  }

  push(chunk: string): SseParseResult {
    this.appendNormalized(chunk);
    const chunks: string[] = [];
    let done = false;
    let fallback = false;
    let boundary = this.buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const event = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const result = this.parseEvent(event);
      chunks.push(...result.chunks);
      done ||= result.done;
      fallback ||= result.fallback;

      boundary = this.buffer.indexOf('\n\n');
    }

    return { chunks, done, fallback };
  }

  finish(): SseParseResult {
    const event = this.buffer;
    this.buffer = '';
    this.previousWasCarriageReturn = false;
    return event ? this.parseEvent(event) : { chunks: [], done: false, fallback: false };
  }

  private appendNormalized(chunk: string): void {
    for (const character of chunk) {
      if (character === '\n' && this.previousWasCarriageReturn) {
        this.previousWasCarriageReturn = false;
        continue;
      }
      this.previousWasCarriageReturn = character === '\r';
      this.buffer += character === '\r' ? '\n' : character;
    }
  }

  private parseEvent(event: string): SseParseResult {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('');

    if (data === '[DONE]') return { chunks: [], done: true, fallback: false };
    if (!data) return { chunks: [], done: false, fallback: false };

    try {
      const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
      const content = parsed.choices?.[0]?.delta?.content;
      if (content !== undefined && typeof content !== 'string') throw new Error();
      if (!content) return { chunks: [], done: false, fallback: false };
      this.accumulated += content;
      return { chunks: [content], done: false, fallback: false };
    } catch {
      return { chunks: [], done: false, fallback: true };
    }
  }
}

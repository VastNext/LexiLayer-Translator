import { describe, expect, it, vi } from 'vitest';

import { ApiError, parseRetryAfter, withRetry } from '../../src/background/retry';

describe('parseRetryAfter', () => {
  it('解析秒数格式', () => {
    expect(parseRetryAfter('1.5', 0)).toBe(1500);
  });

  it('解析 HTTP 日期格式', () => {
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:02 GMT', 1000)).toBe(1000);
  });
});

describe('withRetry', () => {
  it.each([401, 403])('状态码 %s 不重试', async (status) => {
    const operation = vi.fn().mockRejectedValue(new ApiError(status));

    await expect(withRetry(operation, { sleep: vi.fn() })).rejects.toMatchObject({ status });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('状态码 %s 最多重试两次', async (status) => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new ApiError(status, '失败', 250))
      .mockRejectedValueOnce(new ApiError(status))
      .mockResolvedValue('成功');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(operation, { sleep })).resolves.toBe('成功');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
  });
});

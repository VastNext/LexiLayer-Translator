import { useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { registerInputTranslation } from '../../src/content/input-translation';

afterEach(cleanup);
it('原生 setter 与 input 事件同步 React 受控输入状态', async () => {
  function Form() {
    const [value, setValue] = useState('前你好后');
    return <><input aria-label="受控输入" value={value} onChange={(event) => setValue(event.target.value)} /><output>{value}</output></>;
  }
  render(<Form />);
  const input = screen.getByLabelText('受控输入') as HTMLInputElement;
  input.focus(); input.setSelectionRange(1, 3);
  const controller = registerInputTranslation({ getConfig: async () => ({ activeEngineId: 'google', preferences: {} }), translate: async () => 'hello' });
  try {
    await act(() => controller.onKeyDown({ isTrusted: true, key: 'X', code: 'KeyX', altKey: true, shiftKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent));
    expect(input).toHaveValue('前hello后');
    expect(screen.getByRole('status')).toHaveTextContent('前hello后');
  } finally { controller.dispose(); }
});

// Shared mock function for agents tests
import { vi } from 'vitest';

export const mockInvokeFn = vi.fn();

export function resetMockInvoke() {
  mockInvokeFn.mockReset();
}

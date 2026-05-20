// ============================================================================
// Chat History Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockRequireAuth = vi.fn();
const mockRequireCSRF = vi.fn();
// verifyOwnership stays as the real implementation so the existing supabase
// chain mocks continue to drive the "is this user the owner" decision per
// test (set via mockSingle.mockResolvedValueOnce). Only the entry-point
// guards are swapped out.
vi.mock('@/lib/security', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security')>('@/lib/security');
  return {
    ...actual,
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
  };
});

const mockGetQuickSession = vi.fn();
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/auth', () => ({
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

// Mock supabase with chainable query builder
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockOrder = vi.fn();
const mockFrom = vi.fn();
const mockLimit = vi.fn();
const mockLt = vi.fn();
const mockIlike = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockLimit.mockReturnValue({ data: [], error: null });
  mockLt.mockReturnValue({ data: [], error: null, limit: mockLimit });
  mockOrder.mockReturnValue({ data: [], error: null, limit: mockLimit, lt: mockLt });
  mockIlike.mockReturnValue({ order: mockOrder, limit: mockLimit });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete, limit: mockLimit, ilike: mockIlike, lt: mockLt });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, lt: mockLt });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
    limit: mockLimit,
  });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
}));

import {
  createChatSession,
  saveMessageToSession,
  getChatSessions,
  getSessionMessages,
  deleteChatSession,
  updateSessionTitle,
  searchChatHistory,
} from '@/actions/chat-history';

const testUser = { id: 'user-123', email: 'test@test.com', role: 'user' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Chat History Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAuth.mockResolvedValue({ success: true, user: testUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
    mockGetQuickSession.mockResolvedValue(testUser);
  });

  // ---------------------------------------------------------------------------
  // createChatSession
  // ---------------------------------------------------------------------------

  describe('createChatSession', () => {
    it('should create a session with default title', async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: validUUID }, error: null });

      const result = await createChatSession();

      expect(result.sessionId).toBe(validUUID);
      expect(result.error).toBeUndefined();
      expect(mockFrom).toHaveBeenCalledWith('chat_sessions');
    });

    it('should create a session with custom title', async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: validUUID }, error: null });

      const result = await createChatSession('My Chat');

      expect(result.sessionId).toBe(validUUID);
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await createChatSession();

      expect(result.sessionId).toBeNull();
      expect(result.error).toBe('Not authenticated');
    });

    it('should return error on DB failure', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

      const result = await createChatSession();

      expect(result.sessionId).toBeNull();
      expect(result.error).toBe('DB error');
    });
  });

  // ---------------------------------------------------------------------------
  // saveMessageToSession
  // ---------------------------------------------------------------------------

  describe('saveMessageToSession', () => {
    it('should save a message successfully', async () => {
      // Mock ownership check
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      // Mock insert (no error)
      mockInsert.mockReturnValueOnce({ error: null });

      const result = await saveMessageToSession({
        sessionId: validUUID,
        role: 'user',
        content: 'Hello world',
      });

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith('chat_messages');
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await saveMessageToSession({
        sessionId: validUUID,
        role: 'user',
        content: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid session ID', async () => {
      const result = await saveMessageToSession({
        sessionId: 'not-a-uuid',
        role: 'user',
        content: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid session ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await saveMessageToSession({
        sessionId: validUUID,
        role: 'user',
        content: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should save message with citations', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      mockInsert.mockReturnValueOnce({ error: null });

      const result = await saveMessageToSession({
        sessionId: validUUID,
        role: 'assistant',
        content: 'Here is the answer',
        citations: [
          {
            chunkId: 1,
            page: 5,
            section: 'Test Section',
            excerpt: 'Referenced content',
            similarity: 0.85,
          },
        ],
      });

      expect(result.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getChatSessions
  // ---------------------------------------------------------------------------

  describe('getChatSessions', () => {
    it('should return sessions for authenticated user', async () => {
      // getChatSessions builds a complex chain: select -> eq -> order -> limit -> (optional lt)
      // The final result comes from the chain
      const mockSessions = [
        { id: validUUID, title: 'Test Chat', created_at: '2024-01-01', updated_at: '2024-01-02' },
      ];
      mockLimit.mockReturnValueOnce({ data: mockSessions, error: null });

      const result = await getChatSessions();

      expect(result.sessions).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getChatSessions();

      expect(result.sessions).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should handle pagination with hasMore', async () => {
      // Return 21 items (limit default 20 + 1 extra)
      const sessions = Array.from({ length: 21 }, (_, i) => ({
        id: `session-${i}`,
        title: `Chat ${i}`,
        created_at: '2024-01-01',
        updated_at: `2024-01-${String(i + 1).padStart(2, '0')}`,
      }));
      mockLimit.mockReturnValueOnce({ data: sessions, error: null });

      const result = await getChatSessions();

      expect(result.hasMore).toBe(true);
      expect(result.sessions).toHaveLength(20);
      expect(result.nextCursor).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getSessionMessages
  // ---------------------------------------------------------------------------

  describe('getSessionMessages', () => {
    it('should return messages for session owner', async () => {
      // Mock ownership check
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      // Mock messages query
      mockLimit.mockReturnValueOnce({
        data: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            citations: [],
            compliance_status: null,
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
        error: null,
      });

      const result = await getSessionMessages(validUUID);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Hello');
      expect(result.hasMore).toBe(false);
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getSessionMessages(validUUID);

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid session ID', async () => {
      const result = await getSessionMessages('not-a-uuid');

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Invalid session ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await getSessionMessages(validUUID);

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('Access denied');
    });
  });

  // ---------------------------------------------------------------------------
  // deleteChatSession
  // ---------------------------------------------------------------------------

  describe('deleteChatSession', () => {
    it('should delete a session for owner', async () => {
      // Mock ownership check
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });

      const result = await deleteChatSession(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockLogAuditEvent).toHaveBeenCalled();
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await deleteChatSession(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await deleteChatSession(validUUID, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid session ID', async () => {
      const result = await deleteChatSession('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid session ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await deleteChatSession(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });
  });

  // ---------------------------------------------------------------------------
  // updateSessionTitle
  // ---------------------------------------------------------------------------

  describe('updateSessionTitle', () => {
    it('should update title for session owner', async () => {
      // Mock ownership check
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });

      const result = await updateSessionTitle(validUUID, 'New Title', 'csrf-token');

      expect(result.success).toBe(true);
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await updateSessionTitle(validUUID, 'New Title', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await updateSessionTitle(validUUID, 'New Title', 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid session ID', async () => {
      const result = await updateSessionTitle('not-a-uuid', 'New Title', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid session ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await updateSessionTitle(validUUID, 'New Title', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });
  });

  // ---------------------------------------------------------------------------
  // searchChatHistory
  // ---------------------------------------------------------------------------

  describe('searchChatHistory', () => {
    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await searchChatHistory('test query');

      expect(result.results).toEqual([]);
      expect(result.error).toBe('Not authenticated');
    });

    it('should return empty results for empty query', async () => {
      const result = await searchChatHistory('   ');

      expect(result.results).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    it('should search session titles and message content', async () => {
      // Mock title search
      mockLimit.mockReturnValueOnce({
        data: [
          { id: 'session-1', title: 'Fire Safety Chat', updated_at: '2024-01-01' },
        ],
        error: null,
      });
      // Mock message search
      mockLimit.mockReturnValueOnce({
        data: [
          {
            session_id: 'session-2',
            content: 'Discussion about fire safety requirements in buildings',
            chat_sessions: { title: 'Building Codes', user_id: testUser.id, updated_at: '2024-01-02' },
          },
        ],
        error: null,
      });

      const result = await searchChatHistory('fire safety');

      expect(result.results.length).toBeGreaterThanOrEqual(1);
    });

    it('should deduplicate results by session ID', async () => {
      // Same session in both title and message results
      mockLimit.mockReturnValueOnce({
        data: [
          { id: 'session-1', title: 'Test Chat', updated_at: '2024-01-01' },
        ],
        error: null,
      });
      mockLimit.mockReturnValueOnce({
        data: [
          {
            session_id: 'session-1',
            content: 'Test message content',
            chat_sessions: { title: 'Test Chat', user_id: testUser.id, updated_at: '2024-01-01' },
          },
        ],
        error: null,
      });

      const result = await searchChatHistory('test');

      // Should only have 1 result since same session_id
      expect(result.results).toHaveLength(1);
    });
  });
});

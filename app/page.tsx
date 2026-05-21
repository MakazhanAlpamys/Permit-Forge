'use client';

// ============================================================================
// Main Dashboard Page with Chat History
// ============================================================================

import { useState } from 'react';
import { Header, Sidebar } from '@/components/dashboard';
import { ChatInterface } from '@/components/chat';

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // X1: bump on real session events (create / delete) instead of refetching
  // sessions every time the active session id changes.
  const [sessionsVersion, setSessionsVersion] = useState(0);

  const handleNewChat = () => {
    setCurrentSessionId(null);
  };

  const handleSelectSession = (sessionId: string) => {
    setCurrentSessionId(sessionId);
  };

  const handleSessionCreated = (sessionId: string | null) => {
    setCurrentSessionId(sessionId);
    // A new session was just created — refresh the sidebar's list.
    if (sessionId) {
      setSessionsVersion((v) => v + 1);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <Header onMenuClick={() => setSidebarOpen(!sidebarOpen)} />

      {/* Main Layout */}
      <div className="flex">
        {/* Sidebar */}
        <Sidebar
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          currentSessionId={currentSessionId}
          sessionsVersion={sessionsVersion}
          onNewChat={handleNewChat}
          onSelectSession={handleSelectSession}
        />

        {/* Main Content */}
        <main className="flex-1 h-[calc(100vh-3.5rem)]">
          <ChatInterface
            sessionId={currentSessionId}
            onSessionCreated={handleSessionCreated}
          />
        </main>
      </div>
    </div>
  );
}

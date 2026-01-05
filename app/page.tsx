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

  const handleNewChat = () => {
    setCurrentSessionId(null);
  };

  const handleSelectSession = (sessionId: string) => {
    setCurrentSessionId(sessionId);
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
          onNewChat={handleNewChat}
          onSelectSession={handleSelectSession}
        />

        {/* Main Content */}
        <main className="flex-1 h-[calc(100vh-3.5rem)]">
          <ChatInterface 
            sessionId={currentSessionId}
            onSessionCreated={setCurrentSessionId}
          />
        </main>
      </div>
    </div>
  );
}

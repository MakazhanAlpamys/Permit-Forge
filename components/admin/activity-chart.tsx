'use client';

// ============================================================================
// Admin Dashboard - Activity Chart Component
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart3 } from 'lucide-react';
import type { WeeklyActivity } from '@/actions/admin';

interface ActivityChartProps {
  data: WeeklyActivity[];
  loading?: boolean;
}

export function ActivityChart({ data, loading }: ActivityChartProps) {
  const maxMessages = Math.max(...data.map(d => d.messages), 1);
  
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          Weekly Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-48 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Bar Chart */}
            <div className="flex items-end justify-between h-48 gap-2">
              {data.map((item, index) => (
                <div key={index} className="flex-1 flex flex-col items-center gap-2">
                  <div className="w-full flex flex-col items-center gap-1">
                    <span className="text-xs text-muted-foreground">
                      {item.messages}
                    </span>
                    <div 
                      className="w-full bg-primary/80 rounded-t transition-all duration-300 hover:bg-primary"
                      style={{ 
                        height: `${(item.messages / maxMessages) * 160}px`,
                        minHeight: item.messages > 0 ? '8px' : '2px',
                      }}
                    />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(item.day)}
                  </span>
                </div>
              ))}
            </div>
            
            {/* Legend */}
            <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded bg-primary" />
                <span>Messages</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

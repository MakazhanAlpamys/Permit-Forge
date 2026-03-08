// ============================================================================
// Notification Service — In-App + Email (Resend)
// ============================================================================

import { createAdminClient } from './supabase-server';

import type { NotificationType } from '@/types';

function getFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL || 'PermitForge <onboarding@resend.dev>';
}

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sendEmail?: boolean;
}

/**
 * Create an in-app notification and optionally send an email.
 * Failures are caught silently — this should never break the calling action.
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  const { userId, type, title, body, data = {}, sendEmail = true } = params;

  try {
    const supabase = createAdminClient();

    // 1. Insert in-app notification
    const { error: insertError } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type,
        title,
        body,
        data,
        read: false,
      });

    if (insertError) {
      console.error('Failed to create notification:', insertError.message);
      return;
    }

    // 2. Send email if Resend is configured
    if (sendEmail && process.env.RESEND_API_KEY) {
      try {
        // Fetch user's email
        const { data: user } = await supabase
          .from('users')
          .select('email, username')
          .eq('id', userId)
          .single();

        if (user?.email) {
          const { Resend } = await import('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);

          await resend.emails.send({
            from: getFromEmail(),
            to: user.email,
            subject: title,
            html: getEmailHtml(type, title, body, data),
          });
        }
      } catch (emailError) {
        // Email failures should not break anything
        console.error('Failed to send notification email:', emailError);
      }
    }
  } catch (error) {
    console.error('Notification creation failed:', error);
  }
}

/**
 * Get notification content based on type
 */
export function getNotificationContent(
  type: NotificationType,
  permitName: string,
  comments?: string
): { title: string; body: string } {
  switch (type) {
    case 'permit_submitted':
      return {
        title: 'Permit Submitted',
        body: `Your permit application "${permitName}" has been submitted successfully and is awaiting review.`,
      };
    case 'permit_under_review':
      return {
        title: 'Permit Under Review',
        body: `Your permit application "${permitName}" is now being reviewed by an administrator.`,
      };
    case 'permit_approved':
      return {
        title: 'Permit Approved',
        body: `Your permit application "${permitName}" has been approved.${comments ? ` Comments: ${comments}` : ''}`,
      };
    case 'permit_rejected':
      return {
        title: 'Permit Rejected',
        body: `Your permit application "${permitName}" has been rejected.${comments ? ` Reason: ${comments}` : ''}`,
      };
    case 'permit_revision_requested':
      return {
        title: 'Revision Requested',
        body: `Your permit application "${permitName}" requires revisions.${comments ? ` Details: ${comments}` : ''}`,
      };
  }
}

/**
 * Generate email HTML for notification
 */
/** Escape HTML special characters to prevent injection in emails */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getEmailHtml(
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown>
): string {
  const statusColors: Record<NotificationType, string> = {
    permit_submitted: '#3b82f6',
    permit_under_review: '#eab308',
    permit_approved: '#7c3aed',
    permit_rejected: '#ef4444',
    permit_revision_requested: '#f97316',
  };

  const color = statusColors[type] || '#6b7280';
  // SECURITY: Escape all user-controlled values to prevent HTML injection in emails
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const permitName = escapeHtml((data.permitName as string) || 'your permit');

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9fafb;">
      <div style="background: white; border-radius: 8px; padding: 32px; border: 1px solid #e5e7eb;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="font-size: 20px; color: #111827; margin: 0;">PermitForge</h1>
          <p style="color: #6b7280; margin: 4px 0 0;">Building Code Compliance</p>
        </div>
        <div style="border-left: 4px solid ${color}; padding-left: 16px; margin: 24px 0;">
          <h2 style="font-size: 18px; color: #111827; margin: 0 0 8px;">${safeTitle}</h2>
          <p style="color: #374151; margin: 0; line-height: 1.6;">${safeBody}</p>
        </div>
        <p style="color: #6b7280; font-size: 14px; margin-top: 24px; text-align: center;">
          Log in to PermitForge to view details about &quot;${permitName}&quot;.
        </p>
      </div>
      <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 16px;">
        This is an automated notification from PermitForge.
      </p>
    </body>
    </html>
  `;
}

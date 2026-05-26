// ============================================================================
// Notification Service — In-App + Email (Nodemailer SMTP)
// ============================================================================

import { createAdminClient } from './supabase-server';
import { getTransporter } from './email';
import { escapeHtml } from './html-escape';

import type { NotificationType } from '@/types';

// SIM-M-9 / v1.9.0 Part D: previously this module had a `switch (type)` and a
// separate `statusColors: Record<NotificationType, string>` map ~30 lines
// apart. Two parallel lookups keyed on the same union type — easy to add a
// new NotificationType and forget the color, drift silently. Collapsed into a
// single Record<NotificationType, NotificationTemplate> so the compiler flags
// any missing case.
interface NotificationTemplate {
  title: string;
  /** Body builder. Receives the permit's project name and optional admin comments. */
  body: (permitName: string, comments?: string) => string;
  color: string;
}

const NOTIFICATION_TEMPLATES: Record<NotificationType, NotificationTemplate> = {
  permit_submitted: {
    title: 'Permit Submitted',
    body: (name) =>
      `Your permit application "${name}" has been submitted successfully and is awaiting review.`,
    color: '#3b82f6',
  },
  permit_under_review: {
    title: 'Permit Under Review',
    body: (name) =>
      `Your permit application "${name}" is now being reviewed by an administrator.`,
    color: '#eab308',
  },
  permit_approved: {
    title: 'Permit Approved',
    body: (name, comments) =>
      `Your permit application "${name}" has been approved.${comments ? ` Comments: ${comments}` : ''}`,
    color: '#7c3aed',
  },
  permit_rejected: {
    title: 'Permit Rejected',
    body: (name, comments) =>
      `Your permit application "${name}" has been rejected.${comments ? ` Reason: ${comments}` : ''}`,
    color: '#ef4444',
  },
  permit_revision_requested: {
    title: 'Revision Requested',
    body: (name, comments) =>
      `Your permit application "${name}" requires revisions.${comments ? ` Details: ${comments}` : ''}`,
    color: '#f97316',
  },
};

const FALLBACK_TEMPLATE: NotificationTemplate = {
  title: 'Permit Update',
  body: (name) => `Your permit application "${name}" has been updated.`,
  color: '#6b7280',
};

function getFromEmail(): string {
  return `PermitForge <${process.env.SMTP_USER}>`;
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

    // 2. Send email if SMTP is configured
    if (sendEmail && process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        // Fetch user's email
        const { data: user } = await supabase
          .from('users')
          .select('email, username')
          .eq('id', userId)
          .single();

        if (user?.email) {
          await getTransporter().sendMail({
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
 * Get notification content based on type.
 *
 * SIM-M-9: now reads from the shared NOTIFICATION_TEMPLATES record so the
 * exhaustiveness checker catches missing cases when a new NotificationType
 * is added.
 */
export function getNotificationContent(
  type: NotificationType,
  permitName: string,
  comments?: string
): { title: string; body: string } {
  const template = NOTIFICATION_TEMPLATES[type] ?? FALLBACK_TEMPLATE;
  return { title: template.title, body: template.body(permitName, comments) };
}

/**
 * Generate email HTML for notification.
 *
 * SIM-M-11 / v1.9.0 Part D: escapeHtml now lives in lib/html-escape (was
 * duplicated here and in lib/email.ts).
 */
function getEmailHtml(
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown>
): string {
  const color = (NOTIFICATION_TEMPLATES[type] ?? FALLBACK_TEMPLATE).color;
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

// ============================================================================
// Email Service — Verification & Password Reset emails via Nodemailer (SMTP)
// ============================================================================

import crypto from 'crypto';
import nodemailer from 'nodemailer';

function getFromEmail(): string {
  return `PermitForge <${process.env.SMTP_USER}>`;
}

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function codeEmailHtml(title: string, code: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

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
        <div style="text-align: center; margin: 24px 0;">
          <h2 style="font-size: 18px; color: #111827; margin: 0 0 8px;">${safeTitle}</h2>
          <p style="color: #374151; margin: 0 0 20px; line-height: 1.6;">${safeMessage}</p>
          <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; display: inline-block;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111827;">${escapeHtml(code)}</span>
          </div>
          <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">This code expires in 15 minutes.</p>
        </div>
      </div>
      <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 16px;">
        If you did not request this, please ignore this email.
      </p>
    </body>
    </html>
  `;
}

export async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP_USER/SMTP_PASS not set — skipping verification email');
    return false;
  }

  try {
    const fromEmail = getFromEmail();
    console.log('[Email] Sending verification email to:', email, 'from:', fromEmail);

    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: 'Verify your email — PermitForge',
      html: codeEmailHtml(
        'Email Verification',
        code,
        'Use the code below to verify your email address.'
      ),
    });

    console.log('[Email] Verification email sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send verification email:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendPasswordResetEmail(email: string, code: string): Promise<boolean> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP_USER/SMTP_PASS not set — skipping password reset email');
    return false;
  }

  try {
    const fromEmail = getFromEmail();
    console.log('[Email] Sending password reset email to:', email, 'from:', fromEmail);

    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: 'Password Reset — PermitForge',
      html: codeEmailHtml(
        'Password Reset',
        code,
        'Use the code below to reset your password.'
      ),
    });

    console.log('[Email] Password reset email sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send password reset email:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function sendPasswordChangeCodeEmail(email: string, code: string): Promise<boolean> {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('SMTP_USER/SMTP_PASS not set — skipping password change email');
    return false;
  }

  try {
    const fromEmail = getFromEmail();
    console.log('[Email] Sending password change email to:', email, 'from:', fromEmail);

    await transporter.sendMail({
      from: fromEmail,
      to: email,
      subject: 'Password Change Code — PermitForge',
      html: codeEmailHtml(
        'Password Change',
        code,
        'Use the code below to confirm your password change.'
      ),
    });

    console.log('[Email] Password change email sent successfully');
    return true;
  } catch (error) {
    console.error('Failed to send password change email:', error instanceof Error ? error.message : error);
    return false;
  }
}

/** Generate a cryptographically random 6-digit code */
export function generateSixDigitCode(): string {
  const num = crypto.randomInt(0, 1_000_000);
  return num.toString().padStart(6, '0');
}

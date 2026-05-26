// ============================================================================
// Email Service — Verification & Password Reset emails via Nodemailer (SMTP)
// ============================================================================

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { escapeHtml } from './html-escape';

// TS-M-6 / v1.6.0 Part E: email logs are intentionally KEPT as console.log
// (audit signal — operators need "verification email to user X.X.X.X was
// dispatched" to correlate user reports). Recipients are hashed via
// hashRecipient() so no PII leaks. The high-volume noise (chat-pipeline,
// tree-cache, semantic-cache hot-path logs) is what gets gated through
// lib/debug-log.

function getFromEmail(): string {
  return `PermitForge <${process.env.SMTP_USER || 'noreply@permitforge.app'}>`;
}

// Hash recipient address for INFO logs so audit-trail correlation still works
// without leaking the address itself.
export function hashRecipient(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);
}

// Lazy transporter — created on first use so env vars are always read at call time,
// not at module load time (fixes broken state when SMTP_* vars arrive after startup)
let _transporter: nodemailer.Transporter | null = null;

export function getTransporter(): nodemailer.Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return _transporter;
}

// SIM-M-11 / v1.9.0 Part D: escapeHtml now lives in lib/html-escape (was
// duplicated here and in lib/notifications.ts).

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

// SIM-H-7 / v1.8.0 Part D: three separate sendXEmail copies collapsed into a
// single sendCodeEmail dispatcher. The per-template differences (subject,
// inner heading, body copy, log labels) live in this map so adding a new
// code-email type is a one-row append. The original three exports stay as
// thin wrappers for callsite stability.
type CodeEmailTemplate = 'verification' | 'password_reset' | 'password_change';

interface CodeEmailTemplateConfig {
  subject: string;
  htmlTitle: string;
  htmlMessage: string;
  /** Operator-facing label used in INFO logs (audit signal, no PII). */
  logLabel: string;
}

const EMAIL_CODE_TEMPLATES: Record<CodeEmailTemplate, CodeEmailTemplateConfig> = {
  verification: {
    subject: 'Verify your email — PermitForge',
    htmlTitle: 'Email Verification',
    htmlMessage: 'Use the code below to verify your email address.',
    logLabel: 'verification',
  },
  password_reset: {
    subject: 'Password Reset — PermitForge',
    htmlTitle: 'Password Reset',
    htmlMessage: 'Use the code below to reset your password.',
    logLabel: 'password reset',
  },
  password_change: {
    subject: 'Password Change Code — PermitForge',
    htmlTitle: 'Password Change',
    htmlMessage: 'Use the code below to confirm your password change.',
    logLabel: 'password change',
  },
};

async function sendCodeEmail(
  email: string,
  code: string,
  template: CodeEmailTemplate,
): Promise<boolean> {
  const cfg = EMAIL_CODE_TEMPLATES[template];

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`SMTP_USER/SMTP_PASS not set — skipping ${cfg.logLabel} email`);
    return false;
  }

  try {
    const fromEmail = getFromEmail();
    console.log('[Email] Sending %s email recipient=%s', cfg.logLabel, hashRecipient(email));

    await getTransporter().sendMail({
      from: fromEmail,
      to: email,
      subject: cfg.subject,
      html: codeEmailHtml(cfg.htmlTitle, code, cfg.htmlMessage),
    });

    console.log('[Email] %s email sent successfully', cfg.logLabel);
    return true;
  } catch (error) {
    console.error(
      `Failed to send ${cfg.logLabel} email:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  return sendCodeEmail(email, code, 'verification');
}

export function sendPasswordResetEmail(email: string, code: string): Promise<boolean> {
  return sendCodeEmail(email, code, 'password_reset');
}

export function sendPasswordChangeCodeEmail(email: string, code: string): Promise<boolean> {
  return sendCodeEmail(email, code, 'password_change');
}

/** Generate a cryptographically random 6-digit code */
export function generateSixDigitCode(): string {
  const num = crypto.randomInt(0, 1_000_000);
  return num.toString().padStart(6, '0');
}

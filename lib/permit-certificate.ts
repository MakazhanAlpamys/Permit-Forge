// ============================================================================
// Permit Certificate PDF Generation (PDFKit — no React dependency)
// ============================================================================

import PDFDocument from 'pdfkit';
import type { BuildingDetails } from '@/types';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CertificateData {
  certificateNumber: string;
  projectName: string;
  projectType: string;
  projectAddress: string;
  plotNumber?: string;
  buildingDetails: BuildingDetails;
  complianceStatus: string;
  approvalDate: string;
  reviewComments?: string;
}

// -----------------------------------------------------------------------------
// Certificate Number Generation
// -----------------------------------------------------------------------------

export function generateCertificateNumber(permitId: string): string {
  const year = new Date().getFullYear();
  const shortId = permitId.replace(/-/g, '').substring(0, 8).toUpperCase();
  return `PF-CERT-${year}-${shortId}`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const s = (val: unknown): string => {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
};

function formatProjectType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Colors
const NAVY = '#1a365d';
const DARK = '#2d3748';
const GRAY = '#718096';
const LIGHT_GRAY = '#a0aec0';
const BORDER = '#e2e8f0';
const GREEN_BG = '#dcfce7';
const GREEN_TEXT = '#166534';
const LIGHT_BG = '#f7fafc';

// -----------------------------------------------------------------------------
// PDF Generation
// -----------------------------------------------------------------------------

export async function generateCertificatePDF(data: CertificateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - 80; // margins

      // ── Header ──────────────────────────────────────────────────────────
      doc
        .font('Helvetica-Bold')
        .fontSize(24)
        .fillColor(NAVY)
        .text('PERMITFORGE', { align: 'center' });

      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(GRAY)
        .text('AI-Powered Building Permit Platform', { align: 'center' })
        .moveDown(0.5);

      // Header border
      doc
        .strokeColor(NAVY)
        .lineWidth(2)
        .moveTo(40, doc.y)
        .lineTo(40 + pageWidth, doc.y)
        .stroke()
        .moveDown(1.5);

      // ── Certificate Title ───────────────────────────────────────────────
      doc
        .font('Helvetica-Bold')
        .fontSize(20)
        .fillColor(DARK)
        .text('BUILDING PERMIT CERTIFICATE', { align: 'center' })
        .moveDown(0.3);

      doc
        .font('Helvetica')
        .fontSize(12)
        .fillColor(GRAY)
        .text(`Certificate No: ${s(data.certificateNumber)}`, { align: 'center' })
        .moveDown(1);

      // ── Status Badge ────────────────────────────────────────────────────
      const statusText = s(data.complianceStatus).toUpperCase();
      const badgeY = doc.y;
      const badgeHeight = 32;
      const badgeWidth = 200;
      const badgeX = (doc.page.width - badgeWidth) / 2;

      doc
        .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 4)
        .fill(GREEN_BG);

      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .fillColor(GREEN_TEXT)
        .text(statusText, badgeX, badgeY + 8, { width: badgeWidth, align: 'center' });

      doc.y = badgeY + badgeHeight + 16;

      // ── Section: Project Information ────────────────────────────────────
      drawSectionTitle(doc, 'Project Information', pageWidth);

      drawRow(doc, 'Project Name:', s(data.projectName), pageWidth);
      drawRow(doc, 'Project Type:', formatProjectType(s(data.projectType)), pageWidth);
      drawRow(doc, 'Address:', s(data.projectAddress), pageWidth);
      if (data.plotNumber) {
        drawRow(doc, 'Plot Number:', s(data.plotNumber), pageWidth);
      }
      drawRow(doc, 'Approval Date:', new Date(s(data.approvalDate)).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      }), pageWidth);

      doc.moveDown(0.8);

      // ── Section: Building Details ───────────────────────────────────────
      drawSectionTitle(doc, 'Building Details', pageWidth);

      const bd = data.buildingDetails;
      drawRow(doc, 'Number of Floors:', s(bd.numberOfFloors), pageWidth);
      drawRow(doc, 'Building Height:', `${s(bd.buildingHeight)} m`, pageWidth);
      drawRow(doc, 'Total Built-Up Area:', `${s(bd.totalBuiltUpArea)} m\u00B2`, pageWidth);
      drawRow(doc, 'Plot Area:', `${s(bd.plotArea)} m\u00B2`, pageWidth);
      drawRow(doc, 'Occupancy Type:', s(bd.occupancyType), pageWidth);
      drawRow(doc, 'Construction Type:', s(bd.constructionType), pageWidth);
      if (bd.totalBuiltUpArea && bd.plotArea && Number(bd.plotArea) > 0) {
        const far = (Number(bd.totalBuiltUpArea) / Number(bd.plotArea)).toFixed(2);
        const coverage = ((Number(bd.totalBuiltUpArea) / Number(bd.numberOfFloors || 1) / Number(bd.plotArea)) * 100).toFixed(1);
        drawRow(doc, 'FAR / Coverage:', `${far} / ${coverage}%`, pageWidth);
      }

      doc.moveDown(0.8);

      // ── Section: Review Comments (optional) ─────────────────────────────
      if (data.reviewComments) {
        drawSectionTitle(doc, 'Review Comments', pageWidth);

        const boxY = doc.y;
        const textOpts = { width: pageWidth - 24 };
        const textHeight = doc.font('Helvetica').fontSize(10).heightOfString(s(data.reviewComments), textOpts);

        doc
          .roundedRect(40, boxY, pageWidth, textHeight + 24, 4)
          .fill(LIGHT_BG);

        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor(GRAY)
          .text(s(data.reviewComments), 52, boxY + 12, textOpts);

        doc.y = boxY + textHeight + 36;
      }

      // ── Footer ──────────────────────────────────────────────────────────
      const footerY = doc.page.height - 80;
      doc
        .strokeColor(BORDER)
        .lineWidth(1)
        .moveTo(40, footerY)
        .lineTo(40 + pageWidth, footerY)
        .stroke();

      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(LIGHT_GRAY)
        .text(
          `Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} | PermitForge`,
          40, footerY + 8,
          { width: pageWidth, align: 'center' },
        )
        .text(
          'This is a system-generated document. Please verify with the relevant authorities.',
          40, footerY + 20,
          { width: pageWidth, align: 'center' },
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// -----------------------------------------------------------------------------
// Drawing Helpers
// -----------------------------------------------------------------------------

function drawSectionTitle(doc: PDFKit.PDFDocument, title: string, pageWidth: number) {
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(NAVY)
    .text(title)
    .moveDown(0.2);

  doc
    .strokeColor(BORDER)
    .lineWidth(1)
    .moveTo(40, doc.y)
    .lineTo(40 + pageWidth, doc.y)
    .stroke()
    .moveDown(0.5);
}

function drawRow(doc: PDFKit.PDFDocument, label: string, value: string, pageWidth: number) {
  const y = doc.y;
  const labelWidth = pageWidth * 0.4;
  const valueWidth = pageWidth * 0.6;

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(GRAY)
    .text(label, 40, y, { width: labelWidth });

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(DARK)
    .text(value, 40 + labelWidth, y, { width: valueWidth });

  doc.y = Math.max(doc.y, y + 16);
}

// ============================================================================
// Permit Certificate PDF Generation
// ============================================================================

import React from 'react';
import { renderToBuffer, Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
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

/**
 * Generate a unique certificate number
 * Format: EF-CERT-{YEAR}-{SHORT_ID}
 */
export function generateCertificateNumber(permitId: string): string {
  const year = new Date().getFullYear();
  const shortId = permitId.replace(/-/g, '').substring(0, 8).toUpperCase();
  return `EF-CERT-${year}-${shortId}`;
}

// -----------------------------------------------------------------------------
// PDF Styles
// -----------------------------------------------------------------------------

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontFamily: 'Helvetica',
    backgroundColor: '#FFFFFF',
  },
  header: {
    textAlign: 'center' as const,
    marginBottom: 30,
    paddingBottom: 20,
    borderBottom: '2px solid #1a365d',
  },
  title: {
    fontSize: 24,
    fontFamily: 'Helvetica-Bold',
    color: '#1a365d',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 12,
    color: '#4a5568',
    marginBottom: 8,
  },
  certificateTitle: {
    fontSize: 20,
    fontFamily: 'Helvetica-Bold',
    color: '#2d3748',
    textAlign: 'center' as const,
    marginTop: 20,
    marginBottom: 8,
  },
  certNumber: {
    fontSize: 12,
    color: '#718096',
    textAlign: 'center' as const,
    marginBottom: 24,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: '#1a365d',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottom: '1px solid #e2e8f0',
  },
  row: {
    flexDirection: 'row' as const,
    marginBottom: 4,
    paddingVertical: 3,
  },
  label: {
    fontSize: 10,
    color: '#718096',
    width: '40%',
  },
  value: {
    fontSize: 10,
    color: '#2d3748',
    width: '60%',
    fontFamily: 'Helvetica-Bold',
  },
  statusBadge: {
    textAlign: 'center' as const,
    padding: '8px 16px',
    backgroundColor: '#c6f6d5',
    borderRadius: 4,
    marginVertical: 16,
  },
  statusText: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: '#22543d',
  },
  commentsBox: {
    backgroundColor: '#f7fafc',
    padding: 12,
    borderRadius: 4,
    marginTop: 8,
  },
  commentsText: {
    fontSize: 10,
    color: '#4a5568',
    lineHeight: 1.5,
  },
  footer: {
    position: 'absolute' as const,
    bottom: 40,
    left: 40,
    right: 40,
    textAlign: 'center' as const,
    paddingTop: 16,
    borderTop: '1px solid #e2e8f0',
  },
  footerText: {
    fontSize: 8,
    color: '#a0aec0',
  },
});

// -----------------------------------------------------------------------------
// PDF Document Component
// -----------------------------------------------------------------------------

function CertificateDocument({ data }: { data: CertificateData }) {
  const formatProjectType = (type: string) =>
    type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: 'A4', style: styles.page },
      // Header
      React.createElement(
        View,
        { style: styles.header },
        React.createElement(Text, { style: styles.title }, 'EMIRATE FORGE'),
        React.createElement(Text, { style: styles.subtitle }, 'Dubai Building Code 2021 Compliance System'),
      ),
      // Certificate Title
      React.createElement(Text, { style: styles.certificateTitle }, 'BUILDING PERMIT CERTIFICATE'),
      React.createElement(Text, { style: styles.certNumber }, `Certificate No: ${data.certificateNumber}`),
      // Approval Status
      React.createElement(
        View,
        { style: styles.statusBadge },
        React.createElement(Text, { style: styles.statusText }, 'APPROVED'),
      ),
      // Project Information
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, 'Project Information'),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Project Name:'),
          React.createElement(Text, { style: styles.value }, data.projectName),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Project Type:'),
          React.createElement(Text, { style: styles.value }, formatProjectType(data.projectType)),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Address:'),
          React.createElement(Text, { style: styles.value }, data.projectAddress),
        ),
        data.plotNumber
          ? React.createElement(
            View,
            { style: styles.row },
            React.createElement(Text, { style: styles.label }, 'Plot Number:'),
            React.createElement(Text, { style: styles.value }, data.plotNumber),
          )
          : null,
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Approval Date:'),
          React.createElement(Text, { style: styles.value }, new Date(data.approvalDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })),
        ),
      ),
      // Building Details
      React.createElement(
        View,
        { style: styles.section },
        React.createElement(Text, { style: styles.sectionTitle }, 'Building Details'),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Number of Floors:'),
          React.createElement(Text, { style: styles.value }, String(data.buildingDetails.numberOfFloors)),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Building Height:'),
          React.createElement(Text, { style: styles.value }, `${data.buildingDetails.buildingHeight} m`),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Total Built-Up Area:'),
          React.createElement(Text, { style: styles.value }, `${data.buildingDetails.totalBuiltUpArea.toLocaleString()} m\u00B2`),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Plot Area:'),
          React.createElement(Text, { style: styles.value }, `${data.buildingDetails.plotArea.toLocaleString()} m\u00B2`),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Occupancy Type:'),
          React.createElement(Text, { style: styles.value }, data.buildingDetails.occupancyType),
        ),
        React.createElement(
          View,
          { style: styles.row },
          React.createElement(Text, { style: styles.label }, 'Construction Type:'),
          React.createElement(Text, { style: styles.value }, data.buildingDetails.constructionType),
        ),
      ),
      // Review Comments
      data.reviewComments
        ? React.createElement(
          View,
          { style: styles.section },
          React.createElement(Text, { style: styles.sectionTitle }, 'Review Comments'),
          React.createElement(
            View,
            { style: styles.commentsBox },
            React.createElement(Text, { style: styles.commentsText }, data.reviewComments),
          ),
        )
        : null,
      // Footer
      React.createElement(
        View,
        { style: styles.footer },
        React.createElement(Text, { style: styles.footerText }, `Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} | Emirate Forge - Dubai Building Code Compliance System`),
        React.createElement(Text, { style: styles.footerText }, 'This is a system-generated document. Please verify with the relevant authorities.'),
      ),
    ),
  );
}

// -----------------------------------------------------------------------------
// PDF Generation
// -----------------------------------------------------------------------------

/**
 * Generate a PDF certificate buffer for an approved permit
 */
export async function generateCertificatePDF(data: CertificateData): Promise<Buffer> {
  const doc = React.createElement(CertificateDocument, { data }) as React.ReactElement;
  const buffer = await renderToBuffer(doc);
  return Buffer.from(buffer);
}

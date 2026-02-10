// ============================================================================
// Permit Certificate Download API Route
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession, logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { uuidSchema } from '@/lib/validations';
import { createServerClient, createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { generateCertificateNumber, generateCertificatePDF, type CertificateData } from '@/lib/permit-certificate';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Rate limiting
    const rateLimitResult = await checkRateLimit(user.id);
    if (!rateLimitResult.allowed) {
      return Response.json(
        { error: 'Rate limited', retryAfter: rateLimitResult.retryAfterMs },
        { status: 429 }
      );
    }

    const { id: permitId } = await params;
    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return Response.json({ error: 'Invalid permit ID' }, { status: 400 });
    }

    // Fetch permit data
    const supabase = user.role === 'admin' ? createAdminClient() : createServerClient();
    let query = supabase
      .from('permit_applications')
      .select('*')
      .eq('id', permitId);

    if (user.role !== 'admin') {
      query = query.eq('user_id', user.id);
    }

    const { data: permit, error: fetchError } = await query.single();

    if (fetchError || !permit) {
      return Response.json({ error: 'Permit not found' }, { status: 404 });
    }

    if (permit.status !== 'approved') {
      return Response.json({ error: 'Certificate only available for approved permits' }, { status: 400 });
    }

    // Check if certificate already exists
    const adminClient = createAdminClient();
    const { data: existingCert } = await adminClient
      .from('permit_certificates')
      .select('certificate_number')
      .eq('permit_id', permitId)
      .single();

    const certNumber = existingCert?.certificate_number || generateCertificateNumber(permitId);

    // Generate PDF
    const certData: CertificateData = {
      certificateNumber: certNumber,
      projectName: permit.project_name,
      projectType: permit.project_type,
      projectAddress: permit.project_address,
      plotNumber: permit.plot_number || undefined,
      buildingDetails: permit.building_details,
      complianceStatus: permit.compliance_check_result?.overallStatus || 'approved',
      approvalDate: permit.reviewed_at || permit.updated_at,
      reviewComments: permit.review_comments || undefined,
    };

    const pdfBuffer = await generateCertificatePDF(certData);

    // Save certificate record if it doesn't exist
    if (!existingCert) {
      await adminClient.from('permit_certificates').insert({
        permit_id: permitId,
        certificate_number: certNumber,
        generated_by: user.id,
      });

      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: user.id,
        action: 'permit_certificate_generated',
        metadata: { permitId, certificateNumber: certNumber },
        ...metadata,
      });
    }

    return new Response(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="permit-certificate-${certNumber}.pdf"`,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Certificate generation error:', error);
    return Response.json(
      { error: 'Failed to generate certificate' },
      { status: 500 }
    );
  }
}

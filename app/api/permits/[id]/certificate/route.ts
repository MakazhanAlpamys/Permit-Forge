// ============================================================================
// Permit Certificate Download API Route
// ============================================================================

import { NextRequest } from 'next/server';
import { logAuditWithMeta } from '@/lib/auth';
import { requireAuth } from '@/lib/security';
import { uuidSchema } from '@/lib/validations';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { generateCertificateNumber, generateCertificatePDF, type CertificateData } from '@/lib/permit-certificate';
import { applySecurityHeaders } from '@/lib/api-security-headers';
import { contentDispositionAttachment } from '@/lib/http-headers';
import { canPerformOperation, type PermitStatus } from '@/lib/permit-state-machine';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    // AUTH-C1 / v1.0.0 Part E: route through `requireAuth` so JWT.tv vs.
    // users.token_version is enforced — a revoked admin can't keep pulling
    // certificates for the 7-day token lifetime.
    const auth = await requireAuth();
    if (!auth.success || !auth.user) {
      return applySecurityHeaders(
        Response.json({ error: auth.error || 'Not authenticated' }, { status: 401 }),
      );
    }
    const user = auth.user;

    // C11H/H21: dedicated bucket so certificate downloads don't share the
    // chat / mutation rate-limit budget. Tight cap because cert PDFs are
    // expensive to regenerate and the typical user only needs the file once.
    const rateLimitResult = await checkRateLimit(user.id, {
      endpoint: 'permit_certificate',
      windowSeconds: 60,
      maxRequests: 5,
      minIntervalMs: 1000,
    });
    if (!rateLimitResult.allowed) {
      return applySecurityHeaders(
        Response.json(
          { error: 'Rate limited', retryAfter: rateLimitResult.retryAfterMs },
          { status: 429 }
        )
      );
    }

    const { id: permitId } = await params;
    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return applySecurityHeaders(Response.json({ error: 'Invalid permit ID' }, { status: 400 }));
    }

    // Fetch permit data
    const supabase = createAdminClient();
    let query = supabase
      .from('permit_applications')
      .select('*')
      .eq('id', permitId);

    if (user.role !== 'admin') {
      query = query.eq('user_id', user.id);
    }

    const { data: permit, error: fetchError } = await query.single();

    if (fetchError || !permit) {
      return applySecurityHeaders(Response.json({ error: 'Permit not found' }, { status: 404 }));
    }

    const certCheck = canPerformOperation(permit.status as PermitStatus, 'download_cert');
    if (!certCheck.allowed) {
      return applySecurityHeaders(Response.json({ error: certCheck.reason }, { status: 400 }));
    }

    // X4 / M8: cached-cert path. If we already produced this PDF and stashed
    // it in Storage, serve the bytes from there instead of regenerating with
    // PDFKit (~50–200ms each).
    const adminClient = createAdminClient();
    const { data: existingCert } = await adminClient
      .from('permit_certificates')
      .select('certificate_number, storage_path')
      .eq('permit_id', permitId)
      .single();

    const certNumber = existingCert?.certificate_number || generateCertificateNumber(permitId);
    const cacheBucket = 'permit-certificates';
    const cachePath = `${permitId}/${certNumber}.pdf`;

    if (existingCert?.storage_path) {
      const { data: cachedBlob, error: dlErr } = await adminClient.storage
        .from(cacheBucket)
        .download(existingCert.storage_path as string);

      if (!dlErr && cachedBlob) {
        const cachedBytes = new Uint8Array(await cachedBlob.arrayBuffer());
        return applySecurityHeaders(
          new Response(cachedBytes, {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': contentDispositionAttachment(`permit-certificate-${certNumber}.pdf`),
              'Cache-Control': 'private, max-age=3600',
              'X-Cert-Cache': 'hit',
            },
          })
        );
      }
      // If the object is missing / unreadable, fall through to regenerate.
    }

    // Cache miss → generate the PDF, upload to Storage best-effort, and
    // persist the storage_path on the cert row so the next request hits cache.
    const certData: CertificateData = {
      certificateNumber: certNumber,
      projectName: permit.project_name,
      projectType: permit.project_type,
      projectAddress: permit.project_address,
      plotNumber: permit.plot_number || undefined,
      buildingDetails: permit.building_details,
      complianceStatus: permit.compliance_check_result?.overallStatus || 'approved',
      approvalDate: permit.reviewed_at || permit.updated_at,
      expiryDate: permit.expires_at || undefined,
      permitType: permit.permit_type || undefined,
      ownerName: permit.owner_name || undefined,
      ownerPhone: permit.owner_phone || undefined,
      ownerEmiratesId: permit.owner_emirates_id || undefined,
      reviewComments: permit.review_comments || undefined,
    };

    const pdfBuffer = await generateCertificatePDF(certData);

    // Upload + insert/update the cert row. Both are best-effort; failure here
    // just means the next download will regenerate again.
    let storedPath: string | null = null;
    try {
      const { error: uploadErr } = await adminClient.storage
        .from(cacheBucket)
        .upload(cachePath, new Uint8Array(pdfBuffer), {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (!uploadErr) storedPath = cachePath;
      else console.error('Certificate cache upload failed:', uploadErr);
    } catch (uploadEx) {
      console.error('Certificate cache upload threw:', uploadEx);
    }

    if (!existingCert) {
      const { error: certInsertError } = await adminClient.from('permit_certificates').insert({
        permit_id: permitId,
        certificate_number: certNumber,
        generated_by: user.id,
        storage_path: storedPath,
      });

      if (certInsertError) {
        // 23505 = unique_violation — another request already created the cert
        if (certInsertError.code !== '23505') {
          console.error('Certificate insert error:', certInsertError);
        }
      } else {
        await logAuditWithMeta(user.id, 'permit_certificate_generated', {
          metadata: { permitId, certificateNumber: certNumber },
        });
      }
    } else if (storedPath && !existingCert.storage_path) {
      // Backfill the storage_path on an older cert row produced before the
      // cache existed. Stale paths from the same cert row get overwritten
      // because we always upload with upsert:true to the same path.
      await adminClient
        .from('permit_certificates')
        .update({ storage_path: storedPath })
        .eq('permit_id', permitId);
    }

    return applySecurityHeaders(
      new Response(new Uint8Array(pdfBuffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': contentDispositionAttachment(`permit-certificate-${certNumber}.pdf`),
          'Cache-Control': 'private, max-age=3600',
          'X-Cert-Cache': 'miss',
        },
      })
    );
  } catch (error) {
    console.error('Certificate generation error:', error);
    return applySecurityHeaders(
      Response.json({ error: 'Failed to generate certificate' }, { status: 500 })
    );
  }
}

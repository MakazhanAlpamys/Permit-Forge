'use client';

// ============================================================================
// New Permit Application — Multi-Step Form
// ============================================================================

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/dashboard';
import { PermitFormStepper, PermitFormStep1, PermitFormStep2, PermitFormStep3, ComplianceCheckPanel, FileUploadZone } from '@/components/permits';
import {
  createPermit,
  updatePermitBuildingDetails,
  updatePermitComplianceRequirements,
  submitPermit,
  runComplianceCheck,
  getMyPermits,
  getPermitById,
} from '@/actions/permits';
import { getPermitAttachments } from '@/actions/permit-attachments';
import { getCSRFTokenAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ArrowLeft } from 'lucide-react';
import type { BuildingDetails, ComplianceRequirements, ComplianceCheckResult, PermitApplication, PermitAttachment } from '@/types';

const STEPS = ['Project Info', 'Building Details', 'Compliance'];

const EMPTY_BUILDING_DETAILS: BuildingDetails = {
  numberOfFloors: 0,
  totalBuiltUpArea: 0,
  plotArea: 0,
  buildingHeight: 0,
  numberOfUnits: 0,
  numberOfParkingSpaces: 0,
  occupancyType: '',
  constructionType: '',
};

const EMPTY_COMPLIANCE: ComplianceRequirements = {
  fireSafety: false,
  accessibility: false,
  parkingCompliance: false,
  structuralSafety: false,
  mepSystems: false,
  energyEfficiency: false,
  additionalNotes: '',
};

// B9: clamp the ?step= URL param so a hand-edited `step=9` can't break the
// stepper. The wizard has three steps; step 1 is also the default.
function parseStep(raw: string | null): 1 | 2 | 3 {
  const n = Number(raw);
  return n === 2 || n === 3 ? n : 1;
}

function applyPermitToFormState(
  permit: PermitApplication,
  setStep1: React.Dispatch<React.SetStateAction<{ projectName: string; projectType: string; projectAddress: string; plotNumber: string; projectDescription: string }>>,
  setStep2: React.Dispatch<React.SetStateAction<BuildingDetails>>,
  setStep3: React.Dispatch<React.SetStateAction<ComplianceRequirements>>,
) {
  setStep1({
    projectName: permit.projectName || '',
    projectType: permit.projectType || '',
    projectAddress: permit.projectAddress || '',
    plotNumber: permit.plotNumber || '',
    projectDescription: permit.projectDescription || '',
  });
  setStep2({ ...EMPTY_BUILDING_DETAILS, ...(permit.buildingDetails || {}) });
  setStep3({ ...EMPTY_COMPLIANCE, ...(permit.complianceRequirements || {}) });
}

// B9 fixup: useSearchParams forces dynamic rendering and Next 15 demands a
// Suspense boundary above any component that calls it, otherwise the static
// prerender step bails out. Wrap the real form in <Suspense> via the default
// export below and keep the implementation in NewPermitPageInner.
export default function NewPermitPage() {
  return (
    <Suspense fallback={null}>
      <NewPermitPageInner />
    </Suspense>
  );
}

function NewPermitPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlPermitId = searchParams.get('id');
  const urlStep = parseStep(searchParams.get('step'));

  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(urlStep);
  const [loading, setLoading] = useState(false);
  const [checkLoading, setCheckLoading] = useState(false);
  const [error, setError] = useState('');
  const [permitId, setPermitId] = useState<string | null>(urlPermitId);
  const [complianceResult, setComplianceResult] = useState<ComplianceCheckResult | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  // X17: cached permit version so we can include `expectedVersion` in
  // every update. Bumped locally after a successful update so subsequent
  // updates in the same form lifetime keep working.
  const [permitVersion, setPermitVersion] = useState<number | undefined>(undefined);
  // B9: gate the form render while we resolve "latest open draft" so we don't
  // briefly flash step 1 before redirecting into an existing draft.
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    getCSRFTokenAction().then(setCsrfToken);
  }, []);

  // Form data
  const [step1Data, setStep1Data] = useState({
    projectName: '',
    projectType: '',
    projectAddress: '',
    plotNumber: '',
    projectDescription: '',
  });

  const [step2Data, setStep2Data] = useState<BuildingDetails>(EMPTY_BUILDING_DETAILS);
  const [step3Data, setStep3Data] = useState<ComplianceRequirements>(EMPTY_COMPLIANCE);
  // B10: load attachments once a permit id exists so the upload zone on step 3
  // can show what's already there. Refreshes after every upload/delete.
  const [attachments, setAttachments] = useState<PermitAttachment[]>([]);

  const refreshAttachments = useCallback(async (id: string | null) => {
    if (!id) {
      setAttachments([]);
      return;
    }
    const result = await getPermitAttachments(id);
    setAttachments(result.data || []);
  }, []);

  useEffect(() => {
    refreshAttachments(permitId);
  }, [permitId, refreshAttachments]);

  // B9: helper to keep URL in sync with state. router.replace avoids creating
  // history entries on every step click — back-button should leave /permits/new
  // entirely, not walk backwards through stepper states.
  const syncUrl = useCallback((id: string | null, step: 1 | 2 | 3) => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (id) params.set('id', id);
    params.set('step', String(step));
    router.replace(`/permits/new?${params.toString()}`);
  }, [router]);

  const goToStep = useCallback((step: 1 | 2 | 3) => {
    setCurrentStep(step);
    syncUrl(permitId, step);
  }, [permitId, syncUrl]);

  // B9: hydrate from URL (?id=...) or fall back to the user's most recently
  // updated draft. Either way we land the user on whatever they were doing
  // last instead of resetting to a blank step 1.
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      // Explicit ?id= takes priority.
      if (urlPermitId) {
        const result = await getPermitById(urlPermitId);
        if (cancelled) return;
        if (result.data && (result.data.status === 'draft' || result.data.status === 'revision_requested')) {
          setPermitId(result.data.id);
          setPermitVersion(result.data.version);
          applyPermitToFormState(result.data, setStep1Data, setStep2Data, setStep3Data);
          setCurrentStep(urlStep);
        } else {
          // Stale / inaccessible id — drop it from the URL and start fresh.
          router.replace('/permits/new');
        }
        setBootstrapping(false);
        return;
      }

      // No ?id= — look for the user's latest open draft and pivot to it.
      const my = await getMyPermits();
      if (cancelled) return;
      const latestDraft = my.data.find(p => p.status === 'draft' || p.status === 'revision_requested');
      if (latestDraft) {
        setPermitId(latestDraft.id);
        setPermitVersion(latestDraft.version);
        applyPermitToFormState(latestDraft, setStep1Data, setStep2Data, setStep3Data);
        // Resume on step 2 if building details exist, step 3 if compliance
        // requirements exist — otherwise step 1 is the natural entry point.
        const bd = latestDraft.buildingDetails;
        const cr = latestDraft.complianceRequirements;
        const hasBuilding = !!(bd && bd.numberOfFloors);
        const hasCompliance = !!(cr && (cr.fireSafety || cr.accessibility || cr.parkingCompliance || cr.structuralSafety || cr.mepSystems || cr.energyEfficiency));
        const resumeStep: 1 | 2 | 3 = hasCompliance ? 3 : hasBuilding ? 2 : 1;
        setCurrentStep(resumeStep);
        syncUrl(latestDraft.id, resumeStep);
      }
      setBootstrapping(false);
    }

    hydrate();
    return () => { cancelled = true; };
    // We deliberately depend only on the initial URL params; later step changes
    // route through goToStep, which calls syncUrl directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 1 → Create draft
  const handleStep1Next = async () => {
    setError('');
    setLoading(true);

    const result = await createPermit({
      projectName: step1Data.projectName,
      projectType: step1Data.projectType as 'residential' | 'commercial' | 'industrial' | 'mixed_use' | 'institutional',
      projectAddress: step1Data.projectAddress,
      plotNumber: step1Data.plotNumber || undefined,
      projectDescription: step1Data.projectDescription || undefined,
    }, csrfToken || '');

    setLoading(false);

    if (result.success && result.permitId) {
      setPermitId(result.permitId);
      // B9: stamp the new permit id into the URL so a refresh lands back here
      // instead of a blank step 1.
      syncUrl(result.permitId, 2);
      setCurrentStep(2);
    } else {
      setError(result.error || 'Failed to create permit');
    }
  };

  // CP-C-6 (v1.2.0 Part C): snapshot step 2 form state on entry so a Back
  // click can detect unsaved edits and prompt before discarding them.
  const step2SnapshotRef = useRef<BuildingDetails | null>(null);
  useEffect(() => {
    if (currentStep === 2 && step2SnapshotRef.current === null) {
      step2SnapshotRef.current = { ...step2Data };
    }
    if (currentStep !== 2) {
      step2SnapshotRef.current = null;
    }
    // Snapshot is intentionally captured once per step entry, not on every
    // step2Data change — that's what makes "dirty" mean "differs from entry".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  const isStep2Dirty = useCallback(() => {
    const snap = step2SnapshotRef.current;
    if (!snap) return false;
    const keys: (keyof BuildingDetails)[] = [
      'numberOfFloors', 'totalBuiltUpArea', 'plotArea', 'buildingHeight',
      'numberOfUnits', 'numberOfParkingSpaces', 'occupancyType', 'constructionType',
    ];
    return keys.some(k => snap[k] !== step2Data[k]);
  }, [step2Data]);

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const handleStep2Back = () => {
    if (isStep2Dirty()) {
      setDiscardConfirmOpen(true);
      return;
    }
    goToStep(1);
  };

  const confirmDiscardStep2 = () => {
    setDiscardConfirmOpen(false);
    goToStep(1);
  };

  // Step 2 → Save building details
  const handleStep2Next = async () => {
    if (!permitId) return;
    setError('');
    setLoading(true);

    const result = await updatePermitBuildingDetails({
      permitId,
      buildingDetails: step2Data,
      expectedVersion: permitVersion,
    }, csrfToken || '');

    setLoading(false);

    if (result.success) {
      // X17: bump local version so subsequent saves in this form lifetime
      // stay coherent with the DB without a re-fetch.
      if (typeof permitVersion === 'number') setPermitVersion(permitVersion + 1);
      goToStep(3);
    } else {
      setError(result.error || 'Failed to save building details');
    }
  };

  // CP-C-7 (v1.2.0 Part C): separate in-flight refs for Save Draft and Submit
  // so a rapid double-click can't fire either action twice, and a click on
  // one while the other is in-flight is short-circuited. Both refs feed the
  // same `loading` boolean to keep the existing button-disabled wiring.
  const saveDraftInFlightRef = useRef(false);
  const submitInFlightRef = useRef(false);

  // Step 3 → Save compliance + submit
  const handleSaveDraft = async () => {
    if (!permitId) return;
    // CP-C-7: short-circuit when either action is still flying.
    if (saveDraftInFlightRef.current || submitInFlightRef.current) return;
    // CP-E-3: if the AI check is mid-flight, mark it superseded so its
    // result is discarded — saving means the user changed their mind about
    // what to check anyway.
    if (checkInFlightRef.current) {
      checkSupersededRef.current = true;
    }
    saveDraftInFlightRef.current = true;
    setError('');
    setLoading(true);

    try {
      const result = await updatePermitComplianceRequirements({
        permitId,
        complianceRequirements: step3Data,
        expectedVersion: permitVersion,
      }, csrfToken || '');

      if (result.success) {
        if (typeof permitVersion === 'number') setPermitVersion(permitVersion + 1);
        router.push('/permits');
      } else {
        setError(result.error || 'Failed to save');
      }
    } finally {
      setLoading(false);
      saveDraftInFlightRef.current = false;
    }
  };

  const handleSubmit = async () => {
    if (!permitId) return;
    if (submitInFlightRef.current || saveDraftInFlightRef.current) return;
    submitInFlightRef.current = true;
    setError('');
    setLoading(true);

    try {
      // Save compliance requirements first
      const saveResult = await updatePermitComplianceRequirements({
        permitId,
        complianceRequirements: step3Data,
        expectedVersion: permitVersion,
      }, csrfToken || '');

      if (!saveResult.success) {
        setError(saveResult.error || 'Failed to save compliance requirements');
        return;
      }
      if (typeof permitVersion === 'number') setPermitVersion(permitVersion + 1);

      // Then submit
      const submitResult = await submitPermit(permitId, csrfToken || '');

      if (submitResult.success) {
        // B8: surface notification-dispatch failure as a flash on the detail page.
        if (submitResult.warning && typeof window !== 'undefined') {
          window.sessionStorage.setItem(`permit-warning-${permitId}`, submitResult.warning);
        }
        router.push(`/permits/${permitId}`);
      } else {
        setError(submitResult.error || 'Failed to submit');
      }
    } finally {
      setLoading(false);
      submitInFlightRef.current = false;
    }
  };

  // CP-E-2 (v1.2.0 Part E): per-permit lock for runComplianceCheck so a user
  // who has the same draft open in two tabs can't double-bill the LLM.
  const checkInFlightRef = useRef<string | null>(null);
  // CP-E-3 (v1.2.0 Part E): when the user clicks Save Draft while the AI
  // check is in flight, we mark this so the check's setState calls bail out
  // (we can't actually abort the server-side RAG call from here without a
  // signal channel, but we can stop the result from clobbering local state).
  const checkSupersededRef = useRef(false);

  const handleRunCheck = async () => {
    if (!permitId) return;
    if (checkInFlightRef.current === permitId) return; // CP-E-2
    checkInFlightRef.current = permitId;
    checkSupersededRef.current = false;
    setError('');
    setCheckLoading(true);

    try {
      // Save compliance requirements first — abort if save fails
      const saveResult = await updatePermitComplianceRequirements({
        permitId,
        complianceRequirements: step3Data,
        expectedVersion: permitVersion,
      }, csrfToken || '');

      if (!saveResult.success) {
        setError(saveResult.error || 'Failed to save compliance requirements');
        return;
      }
      if (typeof permitVersion === 'number') setPermitVersion(permitVersion + 1);

      const result = await runComplianceCheck(permitId, csrfToken || '');

      // CP-E-3: if a save-draft happened while we were waiting, discard.
      if (checkSupersededRef.current) return;

      if (result.success && result.data) {
        setComplianceResult(result.data);
      } else {
        setError(result.error || 'Failed to run compliance check');
      }
    } finally {
      setCheckLoading(false);
      checkInFlightRef.current = null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-2xl mx-auto px-4 py-6">
        {/* Back button */}
        <Button
          variant="ghost"
          size="sm"
          className="mb-4"
          onClick={() => router.push('/permits')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Permits
        </Button>

        <h1 className="text-2xl font-bold mb-6">New Permit Application</h1>

        {/* Stepper */}
        <PermitFormStepper currentStep={currentStep} steps={STEPS} />

        {bootstrapping && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Loading draft…
          </p>
        )}

        {/* Step content */}
        {!bootstrapping && currentStep === 1 && (
          <PermitFormStep1
            data={step1Data}
            onChange={setStep1Data}
            onNext={handleStep1Next}
            loading={loading}
            error={error}
          />
        )}

        {!bootstrapping && currentStep === 2 && (
          <PermitFormStep2
            data={step2Data}
            onChange={setStep2Data}
            onNext={handleStep2Next}
            onBack={handleStep2Back}
            loading={loading}
            error={error}
          />
        )}

        {!bootstrapping && currentStep === 3 && (
          <>
            <PermitFormStep3
              data={step3Data}
              onChange={setStep3Data}
              onBack={() => goToStep(2)}
              onSaveDraft={handleSaveDraft}
              onSubmit={handleSubmit}
              onRunCheck={handleRunCheck}
              loading={loading}
              checkLoading={checkLoading}
              error={error}
              lastCheckAt={complianceResult?.checkedAt}
              // X14: AI check needs numeric building details. We treat "at
              // least one positive numeric field + occupancy + construction"
              // as the minimum signal so the button stays disabled when
              // step 2 was skipped or left at defaults.
              hasBuildingDetails={
                Boolean(step2Data.occupancyType && step2Data.constructionType) &&
                [step2Data.numberOfFloors, step2Data.totalBuiltUpArea, step2Data.plotArea].some(
                  (v) => Number(v) > 0,
                )
              }
            />

            {/* B10: file uploads belong on step 3 because they're optional and
                require an existing permit row to attach to. Hidden while the
                permit is still unsaved (no id) — step 1/2 must run first. */}
            {permitId && (
              <div className="mt-6 p-4 border border-border rounded-lg bg-card/50">
                <FileUploadZone
                  permitId={permitId}
                  attachments={attachments}
                  onUpdate={() => refreshAttachments(permitId)}
                />
              </div>
            )}

            {complianceResult && (
              <div className="mt-4">
                <ComplianceCheckPanel result={complianceResult} />
              </div>
            )}
          </>
        )}
      </main>

      {/* CP-C-6: dirty-form discard confirmation when leaving Step 2 backward. */}
      <ConfirmDialog
        open={discardConfirmOpen}
        onOpenChange={(open) => { if (!open) setDiscardConfirmOpen(false); }}
        title="Discard changes?"
        description="You have unsaved building details. Going back will discard them."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        confirmVariant="destructive"
        destructive
        onConfirm={confirmDiscardStep2}
      />
    </div>
  );
}

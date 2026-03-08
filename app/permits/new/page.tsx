'use client';

// ============================================================================
// New Permit Application — Multi-Step Form
// ============================================================================

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/dashboard';
import { PermitFormStepper, PermitFormStep1, PermitFormStep2, PermitFormStep3, ComplianceCheckPanel } from '@/components/permits';
import {
  createPermit,
  updatePermitBuildingDetails,
  updatePermitComplianceRequirements,
  submitPermit,
  runComplianceCheck,
} from '@/actions/permits';
import { getCSRFTokenAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import type { BuildingDetails, ComplianceRequirements, ComplianceCheckResult } from '@/types';

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

export default function NewPermitPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [checkLoading, setCheckLoading] = useState(false);
  const [error, setError] = useState('');
  const [permitId, setPermitId] = useState<string | null>(null);
  const [complianceResult, setComplianceResult] = useState<ComplianceCheckResult | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

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
      setCurrentStep(2);
    } else {
      setError(result.error || 'Failed to create permit');
    }
  };

  // Step 2 → Save building details
  const handleStep2Next = async () => {
    if (!permitId) return;
    setError('');
    setLoading(true);

    const result = await updatePermitBuildingDetails({
      permitId,
      buildingDetails: step2Data,
    }, csrfToken || '');

    setLoading(false);

    if (result.success) {
      setCurrentStep(3);
    } else {
      setError(result.error || 'Failed to save building details');
    }
  };

  // Step 3 → Save compliance + submit
  const handleSaveDraft = async () => {
    if (!permitId) return;
    setError('');
    setLoading(true);

    const result = await updatePermitComplianceRequirements({
      permitId,
      complianceRequirements: step3Data,
    }, csrfToken || '');

    setLoading(false);

    if (result.success) {
      router.push('/permits');
    } else {
      setError(result.error || 'Failed to save');
    }
  };

  const handleSubmit = async () => {
    if (!permitId) return;
    setError('');
    setLoading(true);

    // Save compliance requirements first
    const saveResult = await updatePermitComplianceRequirements({
      permitId,
      complianceRequirements: step3Data,
    }, csrfToken || '');

    if (!saveResult.success) {
      setLoading(false);
      setError(saveResult.error || 'Failed to save compliance requirements');
      return;
    }

    // Then submit
    const submitResult = await submitPermit(permitId, csrfToken || '');
    setLoading(false);

    if (submitResult.success) {
      router.push(`/permits/${permitId}`);
    } else {
      setError(submitResult.error || 'Failed to submit');
    }
  };

  const handleRunCheck = async () => {
    if (!permitId) return;
    setError('');
    setCheckLoading(true);

    // Save compliance requirements first — abort if save fails
    const saveResult = await updatePermitComplianceRequirements({
      permitId,
      complianceRequirements: step3Data,
    }, csrfToken || '');

    if (!saveResult.success) {
      setCheckLoading(false);
      setError(saveResult.error || 'Failed to save compliance requirements');
      return;
    }

    const result = await runComplianceCheck(permitId, csrfToken || '');
    setCheckLoading(false);

    if (result.success && result.data) {
      setComplianceResult(result.data);
    } else {
      setError(result.error || 'Failed to run compliance check');
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

        {/* Step content */}
        {currentStep === 1 && (
          <PermitFormStep1
            data={step1Data}
            onChange={setStep1Data}
            onNext={handleStep1Next}
            loading={loading}
            error={error}
          />
        )}

        {currentStep === 2 && (
          <PermitFormStep2
            data={step2Data}
            onChange={setStep2Data}
            onNext={handleStep2Next}
            onBack={() => setCurrentStep(1)}
            loading={loading}
            error={error}
          />
        )}

        {currentStep === 3 && (
          <>
            <PermitFormStep3
              data={step3Data}
              onChange={setStep3Data}
              onBack={() => setCurrentStep(2)}
              onSaveDraft={handleSaveDraft}
              onSubmit={handleSubmit}
              onRunCheck={handleRunCheck}
              loading={loading}
              checkLoading={checkLoading}
              error={error}
            />

            {complianceResult && (
              <div className="mt-4">
                <ComplianceCheckPanel result={complianceResult} />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

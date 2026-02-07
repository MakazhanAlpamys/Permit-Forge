'use client';

import { CheckCircle2 } from 'lucide-react';

interface PermitFormStepperProps {
  currentStep: number;
  steps: string[];
}

export function PermitFormStepper({ currentStep, steps }: PermitFormStepperProps) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {steps.map((label, index) => {
        const stepNum = index + 1;
        const isActive = stepNum === currentStep;
        const isComplete = stepNum < currentStep;

        return (
          <div key={label} className="flex items-center">
            <div className="flex items-center gap-2">
              <div
                className={`flex items-center justify-center h-8 w-8 rounded-full text-xs font-medium transition-colors ${
                  isComplete
                    ? 'bg-primary text-primary-foreground'
                    : isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {isComplete ? <CheckCircle2 className="h-4 w-4" /> : stepNum}
              </div>
              <span
                className={`text-sm hidden sm:inline ${
                  isActive ? 'font-medium text-foreground' : 'text-muted-foreground'
                }`}
              >
                {label}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={`w-8 sm:w-12 h-0.5 mx-2 ${
                  isComplete ? 'bg-primary' : 'bg-muted'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

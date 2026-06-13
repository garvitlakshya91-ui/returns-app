import { Check } from 'lucide-react';

const STEPS = [
  'Find Order',
  'Select Items',
  'Reason',
  'Resolution',
  'Drop-off',
  'Confirm',
];

export default function ProgressStepper({ currentStep }) {
  return (
    <div className="mb-8">
      {/* Mobile: text indicator */}
      <p className="text-sm text-gray-500 mb-3 sm:hidden">
        Step {currentStep} of {STEPS.length}: <span className="font-medium text-gray-700">{STEPS[currentStep - 1]}</span>
      </p>

      {/* Desktop: full stepper */}
      <div className="hidden sm:flex items-center justify-between">
        {STEPS.map((label, i) => {
          const stepNum = i + 1;
          const isCompleted = stepNum < currentStep;
          const isCurrent = stepNum === currentStep;

          return (
            <div key={label} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium
                    ${isCompleted ? 'bg-indigo-600 text-white' : ''}
                    ${isCurrent ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : ''}
                    ${!isCompleted && !isCurrent ? 'bg-gray-200 text-gray-500' : ''}
                  `}
                >
                  {isCompleted ? <Check className="w-4 h-4" /> : stepNum}
                </div>
                <span className={`text-xs mt-1 ${isCurrent ? 'text-indigo-600 font-medium' : 'text-gray-400'}`}>
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-2 mt-[-16px] ${isCompleted ? 'bg-indigo-600' : 'bg-gray-200'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Progress bar (mobile) */}
      <div className="sm:hidden w-full bg-gray-200 rounded-full h-1.5">
        <div
          className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300"
          style={{ width: `${(currentStep / STEPS.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

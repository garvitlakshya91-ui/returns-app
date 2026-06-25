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
  const pct = Math.round((currentStep / STEPS.length) * 100);

  return (
    <div className="mb-8">
      {/* Mobile: label + progress bar */}
      <div className="sm:hidden">
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-sm font-medium text-gray-700">
            {STEPS[currentStep - 1]}
          </p>
          <p className="text-xs text-gray-400">
            Step {currentStep} of {STEPS.length}
          </p>
        </div>
        <div className="w-full bg-gray-200/80 rounded-full h-1.5 overflow-hidden">
          <div
            className="bg-indigo-600 h-full rounded-full transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Desktop: full stepper */}
      <div className="hidden sm:flex items-start">
        {STEPS.map((label, i) => {
          const stepNum = i + 1;
          const isCompleted = stepNum < currentStep;
          const isCurrent = stepNum === currentStep;
          const isLast = i === STEPS.length - 1;

          return (
            <div key={label} className="flex-1 flex flex-col items-center relative">
              {/* Connector line to the next step (drawn behind the circle) */}
              {!isLast && (
                <div className="absolute top-4 left-1/2 w-full h-0.5">
                  <div className={`h-full ${isCompleted ? 'bg-indigo-600' : 'bg-gray-200'}`} />
                </div>
              )}

              {/* Circle */}
              <div
                className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors duration-200
                  ${isCompleted ? 'bg-indigo-600 text-white' : ''}
                  ${isCurrent ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' : ''}
                  ${!isCompleted && !isCurrent ? 'bg-white border-2 border-gray-200 text-gray-400' : ''}
                `}
              >
                {isCompleted ? <Check className="w-4 h-4" /> : stepNum}
              </div>

              <span className={`text-[11px] mt-2 text-center px-1 ${isCurrent ? 'text-indigo-600 font-semibold' : 'text-gray-400'}`}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

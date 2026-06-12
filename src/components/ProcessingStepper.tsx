import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { Check, PawPrint } from 'lucide-react-native';
import { PROCESSING_STEP_LABELS, PROCESSING_WARMTH } from '../constants/strings';
import { useThemeColors } from '../hooks/useThemeColors';

const PROCESSING_STEPS = [
  { status: 'uploading', label: PROCESSING_STEP_LABELS.uploading },
  { status: 'uploaded', label: PROCESSING_STEP_LABELS.uploaded },
  { status: 'transcribing', label: PROCESSING_STEP_LABELS.transcribing },
  { status: 'generating', label: PROCESSING_STEP_LABELS.generating },
  { status: 'completed', label: PROCESSING_STEP_LABELS.completed },
] as const;

const STATUS_ORDER = ['uploading', 'uploaded', 'transcribing', 'transcribed', 'generating', 'completed'];

export function ProcessingStepper({ currentStatus }: { currentStatus: string }) {
  const colors = useThemeColors();
  const [warmthIndex, setWarmthIndex] = useState(0);

  useEffect(() => {
    if (currentStatus === 'failed' || currentStatus === 'completed' || PROCESSING_WARMTH.length < 2) {
      return undefined;
    }
    const timer = setInterval(() => {
      setWarmthIndex((index) => (index + 1) % PROCESSING_WARMTH.length);
    }, 4500);
    return () => clearInterval(timer);
  }, [currentStatus]);

  if (currentStatus === 'failed') return null;

  const currentIndex = STATUS_ORDER.indexOf(currentStatus);

  return (
    <View className="my-4">
      {PROCESSING_STEPS.map((step, i) => {
        const stepIndex = STATUS_ORDER.indexOf(step.status);
        const isComplete = currentIndex > stepIndex;
        const isCurrent = currentIndex === stepIndex;
        const isLast = i === PROCESSING_STEPS.length - 1;

        return (
          <View key={step.status}>
            <View
              className="flex-row items-center mb-1"
              accessibilityLabel={`${step.label}: ${isComplete ? 'complete' : isCurrent ? 'in progress' : 'pending'}`}
            >
              <View
                className={`w-6 h-6 rounded-full justify-center items-center mr-3 ${
                  isComplete
                    ? 'bg-brand-500'
                    : isCurrent
                      ? 'bg-status-warning border-2 border-status-warning'
                      : 'bg-surface-sunken'
                }`}
              >
                {isComplete ? (
                  <Animated.View entering={ZoomIn.duration(300)}>
                    <Check color={colors.contentOnBrand} size={14} strokeWidth={3} />
                  </Animated.View>
                ) : (
                  <Animated.View entering={isCurrent ? ZoomIn.duration(300) : undefined}>
                    <PawPrint
                      color={isCurrent ? colors.statusWarningFg : colors.contentTertiary}
                      size={isCurrent ? 13 : 12}
                      strokeWidth={isCurrent ? 2.6 : 2}
                    />
                  </Animated.View>
                )}
              </View>
              <Text
                numberOfLines={2}
                className={`flex-1 text-body ${
                  isComplete
                    ? 'text-brand-500 font-medium'
                    : isCurrent
                      ? 'text-status-warning font-semibold'
                      : 'text-content-tertiary'
                }`}
              >
                {step.label}
              </Text>
            </View>
            {!isLast && (
              <View className="ml-[11px] mb-1">
                <View
                  className={`w-0.5 h-4 ${
                    isComplete ? 'bg-brand-500' : 'bg-border-default'
                  }`}
                />
              </View>
            )}
          </View>
        );
      })}
      {currentStatus !== 'completed' ? (
        <Animated.Text
          key={PROCESSING_WARMTH[warmthIndex]}
          entering={FadeIn.duration(250)}
          className="text-body-sm text-content-secondary mt-3"
        >
          {PROCESSING_WARMTH[warmthIndex]}
        </Animated.Text>
      ) : null}
    </View>
  );
}

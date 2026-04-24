import React from 'react';
import { Switch, Text, View, type SwitchProps } from 'react-native';
import * as Haptics from 'expo-haptics';
import { cx, runMaybeAsync } from './styles';

interface ToggleProps extends Omit<SwitchProps, 'onValueChange' | 'trackColor' | 'thumbColor'> {
  label?: string;
  description?: string;
  error?: string;
  className?: string;
  onValueChange?: (value: boolean) => void | Promise<void>;
}

export function Toggle({
  label,
  description,
  error,
  value,
  disabled,
  className,
  onValueChange,
  accessibilityLabel,
  ...rest
}: ToggleProps) {
  const handleChange = (nextValue: boolean) => {
    Haptics.selectionAsync().catch(() => {});
    runMaybeAsync('Toggle onValueChange', () => onValueChange?.(nextValue));
  };

  const control = (
    <Switch
      value={value}
      disabled={disabled}
      onValueChange={handleChange}
      trackColor={{ false: '#d6d3d1', true: '#0d8775' }}
      thumbColor="#fff"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityValue={{ text: value ? 'on' : 'off' }}
      accessibilityState={{ disabled, checked: !!value }}
      {...rest}
    />
  );

  if (!label && !description) return control;

  return (
    <View className={cx('flex-row items-center justify-between min-h-[44px]', className)}>
      <View className="flex-1 mr-3">
        {label ? <Text className="text-body font-medium text-stone-900">{label}</Text> : null}
        {description ? (
          <Text className="text-caption text-stone-500 mt-0.5">{description}</Text>
        ) : null}
        {error ? (
          <Text className="text-caption text-danger-600 mt-1" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
      {control}
    </View>
  );
}

import React from 'react';
import { View, Text } from 'react-native';
import { cx } from './styles';

interface FormFieldProps {
  label?: string;
  required?: boolean;
  error?: string;
  helpText?: string;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
}

export function FormField({
  label,
  required = false,
  error,
  helpText,
  children,
  className,
  labelClassName,
}: FormFieldProps) {
  return (
    <View className={cx('mb-3.5', className)}>
      {label ? (
        <Text className={cx('text-body-sm font-medium text-stone-700 mb-1.5', labelClassName)}>
          {label}
          {required ? <Text className="text-danger-500"> *</Text> : null}
        </Text>
      ) : null}
      {children}
      {helpText && !error ? (
        <Text className="text-caption text-stone-500 mt-1">{helpText}</Text>
      ) : null}
      {error ? (
        <Text className="text-caption text-danger-600 mt-1" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

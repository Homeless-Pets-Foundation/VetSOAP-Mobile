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
        <Text className={cx('text-body-sm font-medium text-content-body mb-1.5', labelClassName)}>
          {label}
          {required ? <Text className="text-status-danger"> *</Text> : null}
        </Text>
      ) : null}
      {children}
      {helpText && !error ? (
        <Text className="text-caption text-content-tertiary mt-1">{helpText}</Text>
      ) : null}
      {error ? (
        <Text className="text-caption text-status-danger mt-1" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

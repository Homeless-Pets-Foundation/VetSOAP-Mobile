import React, { useState } from 'react';
import { View, Text, TextInput, type TextInputProps } from 'react-native';

interface TextInputFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  required?: boolean;
  error?: string;
}

export function TextInputField({
  label,
  required = false,
  error,
  onFocus,
  onBlur,
  ...rest
}: TextInputFieldProps) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: any) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: any) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  const borderClass = error
    ? 'border-danger-500'
    : isFocused
      ? 'border-brand-500'
      : 'border-stone-300';

  return (
    <View className="mb-3.5">
      <Text className="text-body-sm font-medium text-stone-700 mb-1.5">
        {label}
        {required && <Text className="text-danger-500"> *</Text>}
      </Text>
      <TextInput
        placeholderTextColor="#a8a29e"
        accessibilityLabel={label}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`input-base min-h-[44px] ${borderClass}`}
        {...rest}
      />
      {error && (
        <Text
          className="text-caption text-danger-600 mt-1"
          accessibilityRole="alert"
        >
          {error}
        </Text>
      )}
    </View>
  );
}

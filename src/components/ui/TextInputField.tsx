import React, { useState } from 'react';
import { View, TextInput, type TextInputProps, type NativeSyntheticEvent, type TargetedEvent } from 'react-native';
import { FormField } from './FormField';
import { cx } from './styles';

interface TextInputFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  required?: boolean;
  error?: string;
  helpText?: string;
  rightAccessory?: React.ReactNode;
  className?: string;
  containerClassName?: string;
}

export function TextInputField({
  label,
  required = false,
  error,
  helpText,
  rightAccessory,
  onFocus,
  onBlur,
  className,
  containerClassName,
  ...rest
}: TextInputFieldProps) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: NativeSyntheticEvent<TargetedEvent>) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: NativeSyntheticEvent<TargetedEvent>) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  const borderClass = error
    ? 'border-danger-500'
    : isFocused
      ? 'border-brand-500'
      : 'border-stone-300';

  return (
    <FormField
      label={label}
      required={required}
      error={error}
      helpText={helpText}
      className={containerClassName}
    >
      {rightAccessory ? (
        <View className={cx('input-base min-h-[44px] flex-row items-center', borderClass, className)}>
          <TextInput
            placeholderTextColor="#78716c"
            accessibilityLabel={label}
            accessibilityHint={required ? 'Required field' : undefined}
            onFocus={handleFocus}
            onBlur={handleBlur}
            className="flex-1 text-body text-stone-900 p-0"
            {...rest}
          />
          {rightAccessory}
        </View>
      ) : (
        <TextInput
          placeholderTextColor="#78716c"
          accessibilityLabel={label}
          accessibilityHint={required ? 'Required field' : undefined}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className={cx('input-base min-h-[44px]', borderClass, className)}
          {...rest}
        />
      )}
    </FormField>
  );
}

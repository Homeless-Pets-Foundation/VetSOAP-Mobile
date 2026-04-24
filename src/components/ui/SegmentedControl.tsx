import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { FormField } from './FormField';
import { cx, HIT_SLOP, runMaybeAsync, TOUCH_TARGET } from './styles';

export interface SegmentedControlOption<Value extends string = string> {
  label: string;
  value: Value;
  description?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<Value extends string = string> {
  options: readonly SegmentedControlOption<Value>[];
  value?: Value | null;
  onValueChange: (value: Value | null) => void | Promise<void>;
  label?: string;
  required?: boolean;
  error?: string;
  allowDeselect?: boolean;
  scrollable?: boolean;
  columns?: number;
  className?: string;
  optionClassName?: string;
  accessibilityLabel?: string;
}

export function SegmentedControl<Value extends string = string>({
  options,
  value,
  onValueChange,
  label,
  required = false,
  error,
  allowDeselect = false,
  scrollable = false,
  columns,
  className,
  optionClassName,
  accessibilityLabel,
}: SegmentedControlProps<Value>) {
  const group = (
    <View
      className={cx(scrollable ? 'flex-row gap-1.5' : 'flex-row flex-wrap', className)}
      style={columns ? { marginHorizontal: -4 } : undefined}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        const nextValue = isSelected && allowDeselect ? null : option.value;
        const item = (
          <Pressable
            key={option.value}
            onPress={() => {
              if (option.disabled || (!allowDeselect && isSelected)) return;
              Haptics.selectionAsync().catch(() => {});
              runMaybeAsync('SegmentedControl onValueChange', () => onValueChange(nextValue));
            }}
            disabled={option.disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, disabled: option.disabled }}
            accessibilityLabel={option.label}
            accessibilityHint={option.description}
            hitSlop={HIT_SLOP}
            className={cx(
              TOUCH_TARGET,
              'items-center justify-center rounded-btn border px-3.5',
              isSelected ? 'border-brand-500 bg-brand-500' : 'border-stone-300 bg-white',
              option.disabled && 'opacity-50',
              optionClassName
            )}
          >
            <Text
              className={cx(
                'text-body-sm font-medium text-center',
                isSelected ? 'text-white' : 'text-stone-700'
              )}
              numberOfLines={2}
            >
              {option.label}
            </Text>
          </Pressable>
        );

        if (columns) {
          return (
            <View
              key={option.value}
              style={{ width: `${100 / columns}%`, paddingHorizontal: 4, marginBottom: 8 }}
            >
              {item}
            </View>
          );
        }

        return item;
      })}
    </View>
  );

  const content = scrollable ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {group}
    </ScrollView>
  ) : (
    group
  );

  if (!label && !error) return content;

  return (
    <FormField label={label} required={required} error={error}>
      {content}
    </FormField>
  );
}

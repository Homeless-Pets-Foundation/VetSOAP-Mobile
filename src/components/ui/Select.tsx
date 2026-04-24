import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { FormField } from './FormField';
import { Sheet } from './Sheet';
import { cx, HIT_SLOP, runMaybeAsync, TOUCH_TARGET, UI_COLORS } from './styles';

export interface SelectOption<Value extends string = string> {
  label: string;
  value: Value;
  description?: string;
  disabled?: boolean;
}

interface SelectProps<Value extends string = string> {
  options: readonly SelectOption<Value>[];
  value?: Value | null;
  onValueChange: (value: Value) => void | Promise<void>;
  label?: string;
  required?: boolean;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
  sheetTitle?: string;
  className?: string;
  fieldClassName?: string;
}

export function Select<Value extends string = string>({
  options,
  value,
  onValueChange,
  label,
  required = false,
  error,
  placeholder = 'Select an option',
  disabled = false,
  accessibilityLabel,
  sheetTitle,
  className,
  fieldClassName,
}: SelectProps<Value>) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );

  const field = (
    <>
      <Pressable
        onPress={() => {
          if (disabled) return;
          Haptics.selectionAsync().catch(() => {});
          setIsOpen(true);
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label ?? placeholder}
        accessibilityState={{ disabled, expanded: isOpen }}
        hitSlop={HIT_SLOP}
        className={cx(
          TOUCH_TARGET,
          'input-base flex-row items-center justify-between',
          error ? 'border-danger-500' : isOpen ? 'border-brand-500' : 'border-stone-300',
          disabled && 'opacity-50',
          fieldClassName
        )}
      >
        <Text
          className={cx('text-body flex-1 mr-3', selected ? 'text-stone-900' : 'text-stone-500')}
          numberOfLines={1}
        >
          {selected?.label ?? placeholder}
        </Text>
        <ChevronDown color={isOpen ? UI_COLORS.brand : UI_COLORS.stone} size={18} />
      </Pressable>
      <Sheet
        visible={isOpen}
        onClose={() => setIsOpen(false)}
        title={sheetTitle ?? label}
        closeLabel="Close options"
      >
        <View className="gap-1">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <Pressable
                key={option.value}
                disabled={option.disabled}
                onPress={() => {
                  if (option.disabled) return;
                  Haptics.selectionAsync().catch(() => {});
                  setIsOpen(false);
                  runMaybeAsync('Select onValueChange', () => onValueChange(option.value));
                }}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityHint={option.description}
                accessibilityState={{ selected: isSelected, disabled: option.disabled }}
                hitSlop={HIT_SLOP}
                className={cx(
                  'flex-row items-center min-h-[48px] rounded-input px-3 py-2',
                  isSelected ? 'bg-brand-50' : 'bg-white',
                  option.disabled && 'opacity-50'
                )}
              >
                <View className="flex-1 mr-3">
                  <Text
                    className={cx(
                      'text-body font-medium',
                      isSelected ? 'text-brand-700' : 'text-stone-900'
                    )}
                  >
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text className="text-caption text-stone-500 mt-0.5">
                      {option.description}
                    </Text>
                  ) : null}
                </View>
                {isSelected ? <Check color={UI_COLORS.brand} size={18} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );

  if (!label && !error) {
    return <View className={className}>{field}</View>;
  }

  return (
    <FormField label={label} required={required} error={error} className={className}>
      {field}
    </FormField>
  );
}

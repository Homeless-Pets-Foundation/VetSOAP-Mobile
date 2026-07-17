import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useThemeColors } from '../../hooks/useThemeColors';
import { FormField } from './FormField';
import { Sheet } from './Sheet';
import { cx, HIT_SLOP, runMaybeAsync, TOUCH_TARGET } from './styles';

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

// Growth path: option lists are small today (species, models, languages). If
// one outgrows a sheet, add a `searchable` prop with a filter TextInput at the
// top of the sheet rather than swapping to platform-divergent pickers.
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
  const colors = useThemeColors();
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
        // press-scale (0.98) matching ListItem / SegmentedControl.
        style={({ pressed }) => (pressed && !disabled ? { transform: [{ scale: 0.98 }] } : null)}
        className={cx(
          TOUCH_TARGET,
          'input-base flex-row items-center justify-between',
          error ? 'border-danger-500' : isOpen ? 'border-brand-500' : 'border-border-strong',
          disabled && 'opacity-50',
          fieldClassName
        )}
      >
        <Text
          className={cx('text-body flex-1 mr-3', selected ? 'text-content-primary' : 'text-content-tertiary')}
          numberOfLines={1}
        >
          {selected?.label ?? placeholder}
        </Text>
        <ChevronDown color={isOpen ? colors.brand500 : colors.stone500} size={18} />
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
                  isSelected ? 'bg-surface-sunken' : 'bg-surface-raised',
                  option.disabled && 'opacity-50'
                )}
              >
                <View className="flex-1 mr-3">
                  <Text
                    className={cx(
                      'text-body font-medium',
                      isSelected ? 'text-brand-600' : 'text-content-primary'
                    )}
                  >
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text className="text-caption text-content-tertiary mt-0.5">
                      {option.description}
                    </Text>
                  ) : null}
                </View>
                {isSelected ? <Check color={colors.brand500} size={18} /> : null}
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

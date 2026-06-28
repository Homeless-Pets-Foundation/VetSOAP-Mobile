import React, { useCallback } from 'react';
import { Alert, Linking, Text, View } from 'react-native';
import { ExternalLink } from 'lucide-react-native';
import { CONSULT_COPY } from '../constants/strings';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { useThemeColors } from '../hooks/useThemeColors';

// Static outbound link to the Captivet web app Consult AI tool.
const CONSULT_URL = 'https://app.captivet.com/consult';

export function ConsultAICard() {
  const colors = useThemeColors();
  const open = useCallback(() => {
    Linking.openURL(CONSULT_URL).catch(() => {
      Alert.alert('Could Not Open Link', 'Please try again in a moment.');
    });
  }, []);

  return (
    <Card className="mx-5 mb-4">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-body-lg font-semibold text-content-primary">{CONSULT_COPY.title}</Text>
          <Text className="text-body-sm text-content-tertiary mt-0.5">{CONSULT_COPY.body}</Text>
        </View>
        <Button
          variant="primary"
          size="sm"
          onPress={open}
          accessibilityLabel="Open Consult AI in the Captivet web app"
          icon={<ExternalLink color={colors.contentOnBrand} size={14} />}
        >
          {CONSULT_COPY.open}
        </Button>
      </View>
    </Card>
  );
}

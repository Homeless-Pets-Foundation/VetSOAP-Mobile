import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, FileClock, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { canRecordAppointments } from '../../src/lib/recordingPermissions';
import {
  supportStaffRecoveryVault,
  type RecoveryItem,
  type RecoverySlot,
} from '../../src/lib/supportStaffRecoveryVault';
import { useAuthUser } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Button } from '../../src/components/ui/Button';
import { Card } from '../../src/components/ui/Card';
import { IconButton } from '../../src/components/ui/IconButton';
import { captureMessage } from '../../src/lib/monitoring';
import type { CreateRecording } from '../../src/types';

const RECOVERY_LOAD_TIMEOUT_MS = 12_000;

const EMPTY_FORM: CreateRecording = {
  patientName: '',
  clientName: '',
  species: '',
  breed: '',
  appointmentType: '',
};

function formKey(itemId: string, slotId: string): string {
  return `${itemId}:${slotId}`;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown date';
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown duration';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
}

function itemDuration(item: RecoveryItem): number {
  return item.slots.reduce((sum, slot) => sum + slot.audioDuration, 0);
}

function sourceLabel(item: RecoveryItem): string {
  return item.sourceUserName || item.sourceUserEmail || `User ${item.sourceUserId.slice(0, 8)}`;
}

function requiresForm(slot: RecoverySlot): boolean {
  return !slot.formData;
}

function isFormComplete(form: CreateRecording | undefined): boolean {
  return !!form?.patientName?.trim() && !!form.clientName?.trim() && !!form.species?.trim();
}

export default function RecordingRecoveryScreen() {
  const router = useRouter();
  const user = useAuthUser();
  const { iconMd, iconLg } = useResponsive();
  const colors = useThemeColors();
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, CreateRecording>>({});
  const [scanTimedOut, setScanTimedOut] = useState(false);
  const loadIdRef = useRef(0);

  const canRecover = canRecordAppointments(user?.role);

  const loadItems = useCallback(async () => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;

    if (!canRecover) {
      setItems([]);
      setLoading(false);
      setScanning(false);
      setScanTimedOut(false);
      return;
    }

    setLoading(true);
    setScanning(true);
    setScanTimedOut(false);

    const timeout = setTimeout(() => {
      if (loadIdRef.current !== loadId) return;
      loadIdRef.current += 1;
      setLoading(false);
      setScanning(false);
      setScanTimedOut(true);
      captureMessage('recording_recovery_watchdog_fired', 'warning', {
        tags: { phase: 'recording_recovery' },
        extra: { timeout_ms: RECOVERY_LOAD_TIMEOUT_MS },
      });
    }, RECOVERY_LOAD_TIMEOUT_MS);

    try {
      await supportStaffRecoveryVault.scanForLeftoverRecordingsForUser(user);
      const nextItems = await supportStaffRecoveryVault.listItemsForUser(user);
      if (loadIdRef.current !== loadId) return;
      setItems(nextItems);
      setForms((current) => {
        const next = { ...current };
        for (const item of nextItems) {
          for (const slot of item.slots) {
            if (!requiresForm(slot)) continue;
            const key = formKey(item.id, slot.id);
            next[key] ??= { ...EMPTY_FORM };
          }
        }
        return next;
      });
    } finally {
      clearTimeout(timeout);
      if (loadIdRef.current === loadId) {
        setScanning(false);
        setLoading(false);
      }
    }
  }, [canRecover, user]);

  useEffect(() => {
    loadItems().catch(() => {
      loadIdRef.current += 1;
      setLoading(false);
      setScanning(false);
    });
  }, [loadItems]);

  const updateForm = useCallback(
    (itemId: string, slotId: string, field: keyof CreateRecording, value: string) => {
      const key = formKey(itemId, slotId);
      setForms((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? EMPTY_FORM),
          [field]: value,
        },
      }));
    },
    []
  );

  const handleRestore = useCallback(
    (item: RecoveryItem) => {
      const overrides: Record<string, CreateRecording> = {};
      for (const slot of item.slots) {
        if (!requiresForm(slot)) continue;
        const form = forms[formKey(item.id, slot.id)];
        if (!isFormComplete(form)) {
          Alert.alert('Patient Details Required', 'Add patient name, client name, and species before restoring this audio.');
          return;
        }
        overrides[slot.id] = form!;
      }

      setRestoringId(item.id);
      supportStaffRecoveryVault.restoreItemToCurrentUserDrafts(user, item.id, overrides)
        .then((draftSlotIds) => {
          if (draftSlotIds.length === 0) {
            Alert.alert('Restore Failed', 'No recoverable audio was restored.');
            return;
          }
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          router.replace({
            pathname: '/(tabs)/record',
            params: { draftSlotId: draftSlotIds[0] },
          } as never);
        })
        .catch(() => {
          Alert.alert('Restore Failed', 'Could not restore this recording. Please try again.');
        })
        .finally(() => {
          setRestoringId(null);
        });
    },
    [forms, router, user]
  );

  const handleDelete = useCallback((item: RecoveryItem) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    Alert.alert(
      'Delete Recovery Copy?',
      'This permanently removes the recovery copy from this tablet. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setDeletingId(item.id);
            supportStaffRecoveryVault.deleteItem(user, item.id)
              .then((deleted) => {
                if (!deleted) {
                  Alert.alert('Delete Failed', 'Could not delete this recovery copy.');
                  return;
                }
                return loadItems();
              })
              .catch(() => {
                Alert.alert('Delete Failed', 'Could not delete this recovery copy.');
              })
              .finally(() => {
                setDeletingId(null);
              });
          },
        },
      ]
    );
  }, [loadItems, user]);

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()),
    [items]
  );

  if (!canRecover) {
    return (
      <SafeAreaView className="screen items-center">
        <View className="flex-1 justify-center items-center px-6" style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
          <FileClock color={colors.contentTertiary} size={iconLg} />
          <Text className="text-heading font-bold text-content-primary text-center mt-4 mb-2">
            Recovery Not Available
          </Text>
          <Text className="text-body text-content-tertiary text-center mb-6">
            Only an owner, administrator, or veterinarian can recover local recordings.
          </Text>
          <Button variant="secondary" onPress={() => router.back()}>
            Go Back
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="screen items-center">
      <View className="px-5 pt-5 pb-3" style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="flex-row items-center">
          <IconButton
            icon={<ChevronLeft color={colors.contentPrimary} size={iconMd} />}
            label="Go back"
            onPress={() => router.back()}
            className="mr-3"
          />
          <View className="flex-1">
            <Text className="text-display font-bold text-content-primary" accessibilityRole="header">
              Local Recovery
            </Text>
            <Text className="text-body-sm text-content-tertiary mt-0.5">
              Recover recordings protected during support staff sign-out.
            </Text>
          </View>
        </View>
      </View>

      <ScrollView
        className="flex-1 w-full"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 28, alignItems: 'center' }}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
          {loading ? (
            <View className="py-16 items-center">
              <ActivityIndicator size="large" color={colors.brand500} />
              <Text className="text-body-sm text-content-tertiary mt-3">
                {scanning ? 'Scanning this tablet…' : 'Loading recovery items…'}
              </Text>
            </View>
          ) : sortedItems.length === 0 ? (
            <View className="py-16 items-center px-6">
              <FileClock color={colors.contentTertiary} size={iconLg} />
              <Text className="text-heading font-bold text-content-primary text-center mt-4 mb-2">
                {scanTimedOut ? 'Recovery Check Timed Out' : 'No Recoverable Recordings'}
              </Text>
              <Text className="text-body text-content-tertiary text-center mb-6">
                {scanTimedOut
                  ? 'This tablet did not finish checking local recovery storage. Try again while staying signed in.'
                  : 'Only recovery copies saved during support staff sign-out can be restored automatically. Older leftover files are hidden unless the app can verify they came from this organization.'}
              </Text>
              <Button variant="secondary" onPress={() => loadItems().catch(() => {})}>
                Check Again
              </Button>
            </View>
          ) : (
            sortedItems.map((item) => (
              <Card key={item.id} className="p-5 mb-3">
                <View className="flex-row items-start justify-between mb-3">
                  <View className="flex-1 mr-3">
                    <Text className="text-body-lg font-semibold text-content-primary">
                      {item.slots[0]?.formData?.patientName || 'Recovered Audio'}
                    </Text>
                    <Text className="text-body-sm text-content-tertiary mt-1">
                      {formatDate(item.savedAt)} • {formatDuration(itemDuration(item))}
                    </Text>
                    <Text className="text-caption text-content-tertiary mt-1">
                      From {sourceLabel(item)} • {item.kind.replace('_', ' ')}
                    </Text>
                  </View>
                  <IconButton
                    icon={<Trash2 color={colors.statusDangerFg} size={iconMd} />}
                    label="Delete recovery copy"
                    disabled={deletingId === item.id}
                    onPress={() => handleDelete(item)}
                  />
                </View>

                {item.slots.map((slot, index) => {
                  if (!requiresForm(slot)) return null;
                  const key = formKey(item.id, slot.id);
                  const form = forms[key] ?? EMPTY_FORM;
                  return (
                    <View key={key} className="border-t border-border-default pt-3 mt-3">
                      <Text className="text-body-sm font-semibold text-content-body mb-2">
                        Details for audio {index + 1}
                      </Text>
                      <TextInput
                        value={form.patientName}
                        onChangeText={(value) => updateForm(item.id, slot.id, 'patientName', value)}
                        placeholder="Patient name"
                        placeholderTextColor={colors.contentTertiary}
                        className="bg-surface-raised border border-border-strong rounded-input px-3 py-3 text-body text-content-primary mb-2"
                        accessibilityLabel="Patient name"
                      />
                      <TextInput
                        value={form.clientName ?? ''}
                        onChangeText={(value) => updateForm(item.id, slot.id, 'clientName', value)}
                        placeholder="Client name"
                        placeholderTextColor={colors.contentTertiary}
                        className="bg-surface-raised border border-border-strong rounded-input px-3 py-3 text-body text-content-primary mb-2"
                        accessibilityLabel="Client name"
                      />
                      <TextInput
                        value={form.species ?? ''}
                        onChangeText={(value) => updateForm(item.id, slot.id, 'species', value)}
                        placeholder="Species"
                        placeholderTextColor={colors.contentTertiary}
                        className="bg-surface-raised border border-border-strong rounded-input px-3 py-3 text-body text-content-primary mb-2"
                        accessibilityLabel="Species"
                      />
                      <TextInput
                        value={form.appointmentType ?? ''}
                        onChangeText={(value) => updateForm(item.id, slot.id, 'appointmentType', value)}
                        placeholder="Appointment type"
                        placeholderTextColor={colors.contentTertiary}
                        className="bg-surface-raised border border-border-strong rounded-input px-3 py-3 text-body text-content-primary"
                        accessibilityLabel="Appointment type"
                      />
                    </View>
                  );
                })}

                <View className="mt-4">
                  <Button
                    variant="primary"
                    loading={restoringId === item.id}
                    disabled={!!restoringId || deletingId === item.id || item.status !== 'available'}
                    onPress={() => handleRestore(item)}
                  >
                    Restore to Drafts
                  </Button>
                </View>
              </Card>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

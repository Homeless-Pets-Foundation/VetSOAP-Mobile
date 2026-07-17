import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Phase 3 account API uses additive server contracts', async () => {
  const source = await read('src/api/account.ts');
  assert.match(source, /patch<UpdateMeResponse>\('\/auth\/me'/);
  assert.match(source, /const SubscriptionInfoSchema = z\.object/);
  assert.match(source, /plan: z\.object/);
  assert.match(source, /seatCount: z\.number\(\)/);
  assert.match(source, /capabilities: BillingCapabilitiesSchema/);
  assert.match(source, /apiClient\.get<unknown>\('\/api\/billing\/subscription'\)/);
  assert.match(source, /SubscriptionInfoSchema\.parse\(response\)/);
  assert.match(source, /apiClient\.post<unknown>\('\/api\/billing\/portal'\)/);
  assert.match(source, /PortalSessionResponseSchema\.parse\(response\)/);
  assert.doesNotMatch(source, /manageUrl/);
  assert.match(source, /post<DeleteAccountResponse>\('\/auth\/delete-account',\s*\{ confirmation \}/);
});

test('settings account surface is grouped and support links use direct openURL', async () => {
  const settings = await read('app/(app)/settings.tsx');
  for (const label of ['ACCOUNT', 'SECURITY', 'SUPPORT', 'LEGAL', 'LOCAL RECOVERY', 'DANGER ZONE']) {
    assert.match(settings, new RegExp(label));
  }
  assert.match(settings, /HELP_CENTER_URL/);
  assert.match(settings, /SUPPORT_CONTACT_URL/);
  assert.match(settings, /TERMS_URL/);
  assert.match(settings, /PRIVACY_POLICY_URL/);
  assert.match(settings, /Linking\.openURL\(url\)/);
  assert.doesNotMatch(settings, /canOpenURL/);
  assert.match(settings, /countUnsentRecordings/);
  assert.match(settings, /const canViewBilling = user\?\.role === 'owner' \|\| user\?\.role === 'admin'/);
  assert.match(settings, /\{canViewBilling \? \(/);
});

test('delete-account flow requires typed DELETE, warns on unsent recordings, and preserves logout rules', async () => {
  const source = await read('app/(app)/delete-account.tsx');
  assert.match(source, /confirmation\.trim\(\) !== 'DELETE'/);
  assert.match(source, /countUnsentRecordings\(\)/);
  assert.match(source, /accountApi\.requestDeletion\('DELETE'\)/);
  assert.match(source, /signOut\(\{ recoveryMode: 'best_effort' \}\)/);
  assert.match(source, /setDeletionAccepted\(true\)/);
  assert.match(source, /cancelable:\s*false/);
  assert.match(source, /editable=\{!deletionAccepted\}/);
  assert.match(source, /deletionAccepted \? DELETE_ACCOUNT_COPY\.signOut : DELETE_ACCOUNT_COPY\.requestDeletion/);
  assert.match(source, /account_deletion_requested/);
});

test('delete-account accepted state retries sign-out without re-requesting deletion', async () => {
  const source = await read('app/(app)/delete-account.tsx');
  const signOutHelper = source.match(/const signOutAfterDeletion = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[signOut\]\);/);
  assert.ok(signOutHelper, 'signOutAfterDeletion helper should exist');
  assert.doesNotMatch(signOutHelper[1], /setDeletionAccepted\(false\)/);
  assert.doesNotMatch(signOutHelper[1], /requestDeletion/);

  const acceptedBranch = source.match(/if \(deletionAccepted\) \{([\s\S]*?)\n    \}/);
  assert.ok(acceptedBranch, 'accepted-state branch should exist');
  assert.match(acceptedBranch[1], /signOutAfterDeletion\(\);/);
  assert.doesNotMatch(acceptedBranch[1], /requestDeletion/);
});

test('delete-account surfaces owner-transfer requirement by server code', async () => {
  const source = await read('app/(app)/delete-account.tsx');
  const strings = await read('src/constants/strings.ts');

  assert.match(source, /requestError instanceof ApiError && requestError\.code === 'OWNER_TRANSFER_REQUIRED'/);
  assert.match(source, /DELETE_ACCOUNT_COPY\.ownerTransferRequired/);
  assert.match(strings, /ownerTransferRequired: "You're the only owner\. Transfer organization ownership before deleting your account\."/);
});

test('profile and subscription screens emit PHI-safe analytics only', async () => {
  const profile = await read('app/(app)/profile.tsx');
  assert.match(profile, /PASSWORD_UPDATE_TIMEOUT_MS/);
  assert.match(profile, /withRejectingTimeout\(\s*supabase\.auth\.updateUser\(\{ password \}\)/);
  assert.match(profile, /profile_updated/);
  assert.match(profile, /fields: 'full_name'/);
  assert.match(profile, /fields: 'password'/);
  assert.doesNotMatch(profile, /fullName[^}]*trackEvent/);

  const subscription = await read('app/(app)/subscription.tsx');
  assert.match(subscription, /subscription_viewed/);
  assert.match(subscription, /status: data\.status/);
  assert.match(subscription, /plan\.name/);
  assert.match(subscription, /seatCount/);
  assert.match(subscription, /capabilities\.canManagePortal/);
  assert.match(subscription, /isAllowedBillingUrl\(response\.url\)/);
  assert.match(subscription, /Linking\.openURL\(response\.url\)/);
  assert.match(subscription, /portalMutation\.mutate\(\)/);
  assert.match(subscription, /enabled: canViewBilling/);
  assert.match(subscription, /const hasCents = Math\.abs\(cents % 100\) > Number\.EPSILON/);
  assert.match(subscription, /toFixed\(hasCents \? 2 : 0\)/);
  assert.match(subscription, /if \(!canViewBilling\) return/);
  assert.match(subscription, /canViewBilling\s*\?\s*<RefreshControl/);
  assert.doesNotMatch(subscription, /manageUrl/);
  assert.doesNotMatch(subscription, /canOpenURL/);
});

test('root error fallback text is bounded so Android does not clip retry copy', async () => {
  const layout = await read('app/_layout.tsx');
  assert.match(layout, /maxWidth:\s*640/);
  assert.match(layout, /width:\s*'100%'/);
  assert.match(layout, /lineHeight:\s*22/);
  assert.match(layout, /paddingHorizontal:\s*8/);
  assert.match(layout, /minWidth:\s*128/);
});

test('device registration sends model name without static expo-device import', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  assert.match(provider, /require\('expo-device'\)/);
  assert.match(provider, /Device\.modelName/);
  assert.match(provider, /\.\.\.\(deviceName \? \{ deviceName \} : \{\}\)/);
  assert.doesNotMatch(provider, /import \* as Device from 'expo-device'/);
});

test('USER_UPDATED stays on authenticated branch, not SIGNED_OUT recovery branch', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  assert.match(provider, /if \(newSession\?\.access_token\) \{[\s\S]*await fetchUser\(\);/);
  assert.match(provider, /else \{[\s\S]*SIGNED_OUT both for explicit sign-outs/);
  assert.doesNotMatch(provider, /event === 'USER_UPDATED'[\s\S]{0,240}userInitiatedSignOutRef/);
});

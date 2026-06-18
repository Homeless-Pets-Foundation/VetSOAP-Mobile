import { secureStorage } from './secureStorage';

const KEY_PREFIX = 'captivet_template_default';

function keyForUser(userId: string): string {
  // expo-secure-store rejects any key outside [A-Za-z0-9._-]. The previous ':'
  // separator made every default-template read/write/delete throw (Sentry
  // secure_store_failed, op:getDefaultTemplateId) so the preference never
  // persisted. '_' matches the convention used by every other key in the app.
  return `${KEY_PREFIX}_${userId}`;
}

function isUuidish(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const templatePreference = {
  async getDefaultTemplateId(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const value = await secureStorage.getRawItem(keyForUser(userId), 'getDefaultTemplateId');
    return value && isUuidish(value) ? value : null;
  },

  async setDefaultTemplateId(userId: string | null | undefined, templateId: string): Promise<boolean> {
    if (!userId || !isUuidish(templateId)) return false;
    return secureStorage.setRawItem(keyForUser(userId), templateId, 'setDefaultTemplateId');
  },

  async clearDefaultTemplateId(userId: string | null | undefined): Promise<void> {
    if (!userId) return;
    await secureStorage.deleteRawItem(keyForUser(userId), 'clearDefaultTemplateId');
  },
};

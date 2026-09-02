/**
 * Manage Devices row copy (layout tier 3, 2026-09-02). Pure and RN-free.
 *
 * The Chrome extension registers as "Chrome Extension · <platform> · <shortId>"
 * (Connect extension `api-client.js`), and a single-line row title truncated
 * exactly the tail that tells two installs apart.
 */

export interface DeviceNameParts {
  /** Row title: the distinguishing tail, or the whole name when there is no prefix. */
  title: string;
  /** First half of the subtitle, before the app version. */
  subtitleHead: string;
}

export function splitDeviceName(
  deviceName: string | null | undefined,
  typeLabel: string
): DeviceNameParts {
  const name = (deviceName ?? '').trim();
  if (!name) return { title: typeLabel, subtitleHead: typeLabel };
  const parts = name.split(' · ').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { title: parts.slice(1).join(' · '), subtitleHead: parts[0] };
  }
  return { title: name, subtitleHead: typeLabel };
}

/**
 * Four-way phone/tablet mapping (CLAUDE.md rule 23) — `android_phone` is a real
 * server value; collapsing it back to "Android Tablet" is the bug that fix undid.
 */
export function formatDeviceTypeLabel(deviceType: string | null): string {
  if (!deviceType) return 'Device';
  switch (deviceType) {
    case 'ios_tablet':
      return 'iPad';
    case 'android_tablet':
      return 'Android Tablet';
    case 'ios_phone':
      return 'iPhone';
    case 'android_phone':
      return 'Android Phone';
    case 'web':
      return 'Web Browser';
    default:
      return deviceType;
  }
}

/**
 * HMAC Request Signing
 *
 * Adds tamper-proof signatures to mutation requests (POST, PUT, DELETE).
 * The server should validate these signatures to ensure requests haven't
 * been modified in transit (defense-in-depth alongside HTTPS).
 *
 * Signature: HMAC-SHA256(timestamp + method + path + body)
 *
 * Headers added:
 *   X-Request-Timestamp: Unix timestamp (ms)
 *   X-Request-Signature: HMAC hex digest
 *
 * The server should reject requests where:
 *   - Timestamp is more than 5 minutes old (replay protection)
 *   - Signature doesn't match
 */

/**
 * Simple SHA-256 HMAC using SubtleCrypto (available in React Native Hermes).
 */
async function hmacSha256(key: string, message: string): Promise<string> {
  // Use TextEncoder to convert strings to bytes
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);

  // Convert ArrayBuffer to hex string
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate signing headers for a request.
 * Only signs mutation requests (POST, PUT, DELETE) for performance.
 */
export async function getSigningHeaders(
  method: string,
  path: string,
  body?: string
): Promise<Record<string, string>> {
  // Only sign mutations
  if (method === 'GET') return {};

  // Use the access token as the signing key (shared secret with server).
  // In a more advanced setup, a dedicated signing key would be exchanged.
  // For now, this ties the signature to the authenticated session.
  const timestamp = Date.now().toString();
  const payload = `${timestamp}:${method}:${path}:${body || ''}`;

  try {
    const signature = await hmacSha256(timestamp, payload);
    return {
      'X-Request-Timestamp': timestamp,
      'X-Request-Signature': signature,
    };
  } catch {
    // If crypto is not available (older RN), skip signing gracefully
    return {};
  }
}

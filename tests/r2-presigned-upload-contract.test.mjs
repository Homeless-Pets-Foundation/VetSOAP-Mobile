import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const fixtureUrl = new URL('../contracts/r2-presigned-upload-v1.json', import.meta.url);
const fixtureBytes = await readFile(fixtureUrl);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const validator = await loadTsModule('src/lib/r2UploadUrl.ts');

async function loadProductionUploadWrapper(r2BucketHostname) {
  const violations = [];
  const module = await loadTsModule('src/lib/sslPinning.ts', {
    '../config': {
      API_URL: 'https://api.captivet.com',
      SUPABASE_URL: 'https://synthetic.supabase.co',
      R2_BUCKET_HOSTNAME: r2BucketHostname,
    },
    './monitoring': {
      captureException(error, context) {
        violations.push({ error, context });
      },
    },
    '../api/telemetry': {
      reportClientError(event) {
        violations.push(event);
      },
    },
  });
  return { module, violations };
}

async function loadAppConfigForBuild(env) {
  return loadTsModule(
    'app.config.ts',
    { 'expo/config': {} },
    { process: { env } },
  );
}

test('R2 contract fixture is versioned and byte-pinned', () => {
  assert.equal(fixture.version, 1);
  assert.equal(
    createHash('sha256').update(fixtureBytes).digest('hex'),
    'b8e1a202f978c2513b698d503ee541db53a7dd1967abfb1040a94932594d321f'
  );
  assert.equal(fixture.vectors.length, 30);
});

test('pure R2 validator consumes every cross-repository contract vector', () => {
  const acceptedStyles = new Set();
  for (const vector of fixture.vectors) {
    if (vector.accepted) {
      const result = validator.validateR2PresignedUploadUrl(
        vector.url,
        fixture.configuredVirtualHost
      );
      assert.equal(result.style, vector.style, vector.name);
      assert.ok(result.objectPath.length > 0, vector.name);
      acceptedStyles.add(result.style);
    } else {
      assert.throws(
        () =>
          validator.validateR2PresignedUploadUrl(
            vector.url,
            fixture.configuredVirtualHost
          ),
        validator.R2UploadUrlValidationError,
        vector.name
      );
    }
  }
  assert.deepEqual(
    [...acceptedStyles].sort(),
    ['path_style', 'virtual_hosted']
  );
});

test('R2 bucket configuration requires a canonical virtual bucket hostname', () => {
  const parsed = validator.parseR2BucketConfig(fixture.configuredVirtualHost);
  assert.equal(parsed.bucketName, 'captivet-contract-fixtures');
  assert.equal(parsed.accountId, '0123456789abcdef0123456789abcdef');
  assert.equal(
    parsed.accountHost,
    '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'
  );

  for (const invalid of [
    '',
    '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    'CAPTIVET-CONTRACT-FIXTURES.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    'captivet-contract-fixtures.not-an-account.r2.cloudflarestorage.com',
    'captivet-contract-fixtures.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.evil.test',
    'https://captivet-contract-fixtures.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  ]) {
    assert.equal(validator.parseR2BucketConfig(invalid), null, invalid);
  }
});

test('production EAS builds reject stale or missing R2 hostname secrets before packaging', async () => {
  const baseEnv = {
    APP_VARIANT: 'production',
    EAS_BUILD_PLATFORM: 'android',
  };

  for (const configuredHostname of [
    undefined,
    '17ddf683610714717770b50ff184edd9.r2.cloudflarestorage.com',
    'captivet-other.17ddf683610714717770b50ff184edd9.r2.cloudflarestorage.com',
  ]) {
    const appConfig = await loadAppConfigForBuild({
      ...baseEnv,
      ...(configuredHostname
        ? { EXPO_PUBLIC_R2_BUCKET_HOSTNAME: configuredHostname }
        : {}),
    });
    assert.throws(
      () => appConfig.default({ config: {} }),
      /Invalid EXPO_PUBLIC_R2_BUCKET_HOSTNAME for a production EAS build/,
    );
  }

  const appConfig = await loadAppConfigForBuild({
    ...baseEnv,
    EXPO_PUBLIC_R2_BUCKET_HOSTNAME:
      'captivet-recordings.17ddf683610714717770b50ff184edd9.r2.cloudflarestorage.com',
  });
  assert.doesNotThrow(() => appConfig.default({ config: {} }));
});

test('local config evaluation retains the callable runtime fail-closed path', async () => {
  const appConfig = await loadAppConfigForBuild({
    APP_VARIANT: 'production',
    EXPO_PUBLIC_R2_BUCKET_HOSTNAME:
      '17ddf683610714717770b50ff184edd9.r2.cloudflarestorage.com',
  });

  assert.doesNotThrow(() => appConfig.default({ config: {} }));
});

test('production upload wrapper fails closed and accepts both exact contract styles', async () => {
  for (const configuredHostname of [
    '',
    `https://${fixture.configuredVirtualHost}`,
  ]) {
    const { module, violations } = await loadProductionUploadWrapper(configuredHostname);
    assert.throws(
      () => module.validateUploadUrl(fixture.vectors[0].url),
      /Upload URL failed security validation/,
    );
    assert.equal(violations.length, 2);
  }

  const { module, violations } = await loadProductionUploadWrapper(
    fixture.configuredVirtualHost,
  );
  for (const vector of fixture.vectors.filter(({ accepted }) => accepted)) {
    assert.doesNotThrow(() => module.validateUploadUrl(vector.url), vector.name);
  }
  assert.deepEqual(violations, []);
});

test('production request validator is not broadened to arbitrary R2 hosts', async () => {
  const [sslPinning, config, example] = await Promise.all([
    readFile(new URL('../src/lib/sslPinning.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);

  assert.match(
    sslPinning,
    /validateR2PresignedUploadUrl\(url, R2_BUCKET_HOSTNAME\)/
  );
  assert.doesNotMatch(sslPinning, /r2\.cloudflarestorage\.com['"`]\)/);
  assert.match(config, /Canonical virtual R2 bucket hostname/);
  assert.match(
    example,
    /EXPO_PUBLIC_R2_BUCKET_HOSTNAME=your-bucket-name\.your-account-id\.r2\.cloudflarestorage\.com/
  );
});

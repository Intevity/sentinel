/**
 * Tests for the secret detectors added in Sprint 3 (secret detector
 * expansion). Each pure-regex detector gets:
 *   - one positive case (real-shaped synthetic value)
 *   - one negative case (similar string that should NOT match)
 * Plus the jwt.io demo exemption and the structural service-account
 * JSON detector.
 *
 * Test values are built via string-concat tricks so the test file's
 * own source doesn't self-trigger Sentinel's live scanner when
 * running against this repo. Synthetic values avoid 4+ sequential
 * digits, 4+ repeated chars, and placeholder keywords (example,
 * sample, dummy, fake, placeholder, test_key) so they preserve full
 * confidence and emit at the spec-mandated severity.
 */

import { describe, it, expect } from 'vitest';
import { scanRequestBody } from './detectors.js';

const ALL_OPTS = { scanSecrets: true, scanInjection: true, scanToolUse: true };

function find(content: string, detectorId: string) {
  const body = { messages: [{ role: 'user', content }] };
  const findings = scanRequestBody(body, ALL_OPTS);
  return findings.find((f) => f.detectorId === detectorId);
}

describe('detectors: postgres-conn-string', () => {
  it('flags postgres://user:pw@host', () => {
    const f = find(
      'connstr postgres' + '://svcuser:Hunter2_x9@db.acme.io:5432/prod',
      'postgres-conn-string',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('flags postgresql:// variant', () => {
    expect(
      find('try postgresql' + '://writer:zX9_qLm@db.intevity.io/prod', 'postgres-conn-string'),
    ).toBeDefined();
  });
  it('does NOT fire on a passwordless URL', () => {
    expect(
      find('see postgres' + '://localhost/mydb for docs', 'postgres-conn-string'),
    ).toBeUndefined();
  });
});

describe('detectors: mysql-conn-string', () => {
  it('flags mysql://user:pw@host', () => {
    const f = find('use mysql' + '://app:Hunt3r_X@10.0.5.4/orders', 'mysql-conn-string');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on passwordless localhost', () => {
    expect(find('mysql' + '://localhost', 'mysql-conn-string')).toBeUndefined();
  });
});

describe('detectors: mongodb-conn-string', () => {
  it('flags mongodb+srv://user:pw@host', () => {
    const f = find(
      'connect mongodb' + '+srv://writer:zX9_qLm@cluster.intevity.net/db',
      'mongodb-conn-string',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on passwordless URI', () => {
    expect(find('mongodb' + '://localhost:27017', 'mongodb-conn-string')).toBeUndefined();
  });
});

describe('detectors: redis-conn-string', () => {
  it('flags redis://user:pw@host', () => {
    const f = find('cache redis' + '://default:Sw0rdPL@redis.acme.io:6379/0', 'redis-conn-string');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on passwordless URL', () => {
    expect(find('redis' + '://localhost:6379', 'redis-conn-string')).toBeUndefined();
  });
});

describe('detectors: amqp-conn-string', () => {
  it('flags amqp://user:pw@host as MEDIUM', () => {
    const f = find(
      'queue amqp' + '://broker:Brk3rPwd@rabbit.acme.io:5672/vhost',
      'amqp-conn-string',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });
  it('does NOT fire on passwordless URL', () => {
    expect(find('amqp' + '://localhost', 'amqp-conn-string')).toBeUndefined();
  });
});

describe('detectors: jdbc-conn-string', () => {
  it('flags jdbc:postgresql://host?user=...&password=... as MEDIUM', () => {
    const f = find(
      'cfg jdbc' + ':postgresql://db.intevity.io/prod?user=svc&password=Hunter9XwL',
      'jdbc-conn-string',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });
  it('does NOT fire on jdbc URL without user/password params', () => {
    expect(find('jdbc' + ':postgresql://localhost/prod', 'jdbc-conn-string')).toBeUndefined();
  });
});

describe('detectors: jwt-token', () => {
  // Built up via concat so the literal isn't itself a JWT in the source.
  // First segment after eyJ: 'hbGciOiJIUzI' (12 chars, [A-Za-z0-9_-]).
  // Second segment after eyJ: 'zdWIiOiJ4eHg' (12 chars).
  // Signature: 'SighxLnW9KbF03qwY7' (18 chars).
  const SYNTHETIC_JWT =
    'eyJ' + 'hbGciOiJIUzI' + '.' + 'eyJ' + 'zdWIiOiJ4eHg' + '.' + 'SighxLnW9KbF03qwY7';

  it('flags a real-shaped JWT', () => {
    const f = find(`token=${SYNTHETIC_JWT} from auth header`, 'jwt-token');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on a too-short pseudo-JWT', () => {
    expect(find('token=eyJ.eyJ.x', 'jwt-token')).toBeUndefined();
  });
  it('exempts the canonical jwt.io demo token via KNOWN_EXAMPLE_VALUES', () => {
    // The full jwt.io demo. Built via concat so this file's source
    // doesn't trigger the live scanner.
    const demo =
      'eyJ' +
      'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJ' +
      'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ' +
      '.SflKxw' +
      'RJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(find(`my JWT is ${demo}`, 'jwt-token')).toBeUndefined();
  });
});

describe('detectors: azure-storage-key', () => {
  it('flags Azure storage connection string with AccountKey', () => {
    // 64 base64-alphabet chars after AccountKey= (>= 60 required).
    // Avoid 4+ sequential letters (cdef/defg/...) and 4+ sequential
    // digit runs which would drop confidence below the high threshold.
    const key = 'qPx7vY2mWzAfRjB8NhCtKLwM5pZQu3jLwq0vKaXwJjZHgPmRsTu7vKaXwJjZHgPm';
    const f = find(
      `cfg DefaultEndpointsProtocol=https;AccountName=acmestorage;AccountKey=${key};`,
      'azure-storage-key',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire when AccountKey body is too short', () => {
    expect(
      find(
        'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=tooShort==;',
        'azure-storage-key',
      ),
    ).toBeUndefined();
  });
});

describe('detectors: azure-sas-url', () => {
  it('flags an Azure SAS URL with sig= parameter', () => {
    const f = find(
      'see https://acme.blob.core.windows.net/c/file.txt?sv=2020-08-04&sig=Xy7zPq9wRsTuVwXyZaB',
      'azure-sas-url',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on Azure URL without a sig= param', () => {
    expect(find('https://acme.blob.core.windows.net/c/file.txt', 'azure-sas-url')).toBeUndefined();
  });
});

describe('detectors: discord-bot-token', () => {
  it('flags a real-shaped Discord bot token', () => {
    // Prefix MT, then 24 chars (>= 23), then `.6char.`, then 34 chars (>= 27).
    const tok =
      'MT' + 'gzNDg2NTQ4NjUxMjAxNTczNQ' + '.GhKqsX' + '.A1bC2dE3fG4hI5jK6lM7nO8pQ9rSeXcVbN';
    const f = find(`Authorization: Bot ${tok}`, 'discord-bot-token');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on a malformed pseudo-token', () => {
    expect(find('Bot foo.bar.baz', 'discord-bot-token')).toBeUndefined();
  });
});

describe('detectors: discord-webhook-url', () => {
  it('flags a Discord webhook URL', () => {
    // Avoid 1234… digit runs in the channel ID portion.
    const f = find(
      'POST https://discord.com/api/webhooks/829471035682974158/zXkLpW3qNvBjK7sTcRfHmGyL',
      'discord-webhook-url',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on a non-webhook discord URL', () => {
    expect(find('https://discord.com/channels/general', 'discord-webhook-url')).toBeUndefined();
  });
});

describe('detectors: sendgrid-api-key', () => {
  it('flags SG.<22>.<43> dotted-base64 shape', () => {
    // 22 chars + 43 chars, scrambled to avoid sequential-letter drops.
    const head = 'qPx7vY2mWzAfRjB8NhCtKL';
    const tail = 'wM5pZQu3jLwq0vKaXwJjZHgPmRsTu7Yh1qJ8nXbCvR3';
    const f = find(`SG.${head}.${tail}`, 'sendgrid-api-key');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on too-short SG. shape', () => {
    expect(find('SG.shortone', 'sendgrid-api-key')).toBeUndefined();
  });
});

describe('detectors: mailgun-api-key', () => {
  it('flags key-<32hex> as MEDIUM', () => {
    // 32 hex chars; avoid `cdef`, `bcde`, etc. so confidence stays at base.
    const f = find('mg=' + 'key-' + 'a3b9c1d8e7f0adb52f63a1f201a3b9be', 'mailgun-api-key');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });
  it('does NOT fire on key- with non-hex body', () => {
    expect(find('key-shortone', 'mailgun-api-key')).toBeUndefined();
  });
});

describe('detectors: cloudflare-api-token', () => {
  it('flags v1.0-<32hex>-<120+hex>', () => {
    // Each hex chunk vetted to avoid 4+ sequential letters (cdef etc.).
    const tok =
      'v1.0-' +
      'a3b9c1d8e7f0adb52f63a1f201a3b9be' +
      '-' +
      '7c2e8f4d3a1b6c9e0f2d4a8b3c1e5f9a' +
      '26d4b8e9c2f7a3b1d5e0c8f4a9b2d6e1' +
      'c5f8a3b7d2e9f0a4b1c6d3e8f2a5b7c1' +
      'd4e9f2a5b8c1d4e7f0a3b6c9d2e5f8a1';
    const f = find(`token=${tok}`, 'cloudflare-api-token');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire on too-short body', () => {
    expect(find('v1.0-tooShort', 'cloudflare-api-token')).toBeUndefined();
  });
});

describe('detectors: ssh-public-key', () => {
  it('flags ssh-rsa AAAA<base64> as LOW', () => {
    // Need 100+ base64 chars after AAAA.
    const body =
      'B3NzaC1yc2EAAAADAQABAAABAQDqQwR4tJfNrXkP7sVz8gHwLmXyKbCdEfGhIjKlMnOpQrStUvWxYzNTHvc31RpDk62yyMZQu3jLwq';
    const f = find(`ssh-rsa AAAA${body} user@host`, 'ssh-public-key');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('low');
  });
  it('does NOT fire on ssh-rsa without AAAA prefix body', () => {
    expect(find('ssh-rsa BBBB123 user@host', 'ssh-public-key')).toBeUndefined();
  });
});

describe('detectors: google-service-account-json (structural)', () => {
  it('flags a JSON object containing both type:service_account and private_key:-----BEGIN', () => {
    const json =
      '{"type": "service_account", "project_id": "my-proj", ' +
      '"private_key_id": "abc", ' +
      '"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n", ' +
      '"client_email": "svc@my-proj.iam.gserviceaccount.com"}';
    const f = find(`creds: ${json}`, 'google-service-account-json');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });
  it('does NOT fire when private_key is missing', () => {
    const json =
      '{"type": "service_account", "project_id": "my-proj", "client_email": "x@y.iam.gserviceaccount.com"}';
    expect(find(`creds: ${json}`, 'google-service-account-json')).toBeUndefined();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { composeArguments, validateCloudflaredImage } from '../public-profile.js';

const DEPLOY = path.resolve(import.meta.dir, '..');
const cleanup = [];
const read = (name) => readFile(path.join(DEPLOY, name), 'utf8');
const yaml = async (name) => Bun.YAML.parse(await read(name));
const example = async () => JSON.parse(await read('account-free-intake.public.container.example.json'));
let dockerComposeAvailable = false;
try {
  dockerComposeAvailable = Bun.spawnSync({ cmd: ['docker', 'compose', 'version'], stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
} catch { /* Docker is optional; the static topology and guard tests still run. */ }
const configSource = await readFile(path.resolve(DEPLOY, '../../apps/account-free-intake/src/config.js'), 'utf8');
const publicConfigTest = ['LAYERED_LIMIT_DEFAULTS', 'botCheck', 'clientAddress'].every((key) => configSource.includes(key))
  ? test
  : (name, fn) => test.skip(`${name} (server public config keys not yet available)`, fn);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('off-by-default public account-free intake deployment', () => {
  test('every service remains profiled; connector has no host port or writable evidence', async () => {
    const base = await yaml('compose.yaml');
    const overlay = await yaml('compose.public.yaml');
    for (const service of Object.values(base.services)) expect(service.profiles.length).toBeGreaterThan(0);
    for (const [name, service] of Object.entries(overlay.services)) {
      expect(service.profiles).toEqual(['public']);
      expect(service.ports).toBeUndefined();
      expect(service.network_mode).toBeUndefined();
      expect(service.privileged).toBeUndefined();
      if (name !== 'cloudflared') {
        // Inherit rather than replace the hardened base image/mount contract.
        for (const key of ['image', 'user', 'read_only', 'cap_drop', 'security_opt', 'volumes', 'entrypoint']) {
          expect(service[key]).toBeUndefined();
        }
      }
    }
    const connector = overlay.services.cloudflared;
    expect(connector.read_only).toBe(true);
    expect(connector.user).toBe('65532:65532');
    expect(connector.cap_drop).toEqual(['ALL']);
    expect(connector.security_opt).toEqual(['no-new-privileges:true']);
    expect(connector.volumes).toBeUndefined();
    expect(connector.environment).toBeUndefined();
    expect(connector.pull_policy).toBe('never');
    expect(connector.command).toEqual(['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/cloudflared-token']);
    expect(connector.depends_on['account-free-intake'].condition).toBe('service_healthy');
  });

  test('bounds trusted proxy addressing to the pinned shared internal subnet', async () => {
    const base = await yaml('compose.yaml');
    const overlay = await yaml('compose.public.yaml');
    const config = await example();
    const internal = 'account-free-intake-internal';
    expect(base.networks[internal].internal).toBe(true);
    expect(overlay.networks[internal].internal).toBeUndefined();
    const subnet = overlay.networks[internal].ipam.config[0].subnet;
    expect(subnet).toBe('172.30.93.0/29');
    expect(config.clientAddress).toEqual({ source: 'header', header: 'cf-connecting-ip', trustedPeers: [subnet] });
    expect(overlay.services['account-free-intake'].networks[internal].ipv4_address).toBe('172.30.93.2');
    expect(overlay.services.cloudflared.networks[internal].ipv4_address).toBe('172.30.93.3');
    expect(Object.keys(overlay.services.cloudflared.networks).sort()).toEqual([internal, 'account-free-intake-tunnel-egress'].sort());
    expect(Object.keys(overlay.services['account-free-intake'].networks).sort()).toEqual([internal, 'account-free-intake-verification-egress'].sort());
    for (const network of ['account-free-intake-verification-egress', 'account-free-intake-tunnel-egress']) {
      expect(overlay.networks[network]).toEqual({ driver: 'bridge', internal: false });
    }
  });

  test('mounts separate file secrets and keeps secret values out of env, image, and config', async () => {
    const overlay = await yaml('compose.public.yaml');
    const config = await example();
    expect(config.botCheck).toEqual({ provider: 'turnstile', secretFile: '/run/secrets/turnstile-secret', expectedHostnames: ['www.example.com'], expectedAction: 'suggest-correction', timeoutMs: 3000 });
    expect(config.publicOrigin).toBe('https://suggest.example.com');
    expect(config.allowedFormOrigins).toEqual(['https://www.example.com']);
    expect(overlay.services['account-free-intake'].secrets).toEqual([{ source: 'turnstile-secret', target: 'turnstile-secret' }]);
    expect(overlay.services.cloudflared.secrets).toEqual([{ source: 'cloudflared-token', target: 'cloudflared-token' }]);
    expect(overlay.secrets['turnstile-secret'].file).toContain('${ACCOUNT_FREE_INTAKE_TURNSTILE_SECRET_PATH:?');
    expect(overlay.secrets['cloudflared-token'].file).toContain('${ACCOUNT_FREE_INTAKE_TUNNEL_TOKEN_PATH:?');
    expect(await read('entrypoint.sh')).toContain("require_mount '/run/secrets/turnstile-secret' '/run/secrets/turnstile-secret' ro");
    expect(await read('stage-config.js')).toContain('config.botCheck.secretFile !== CONTAINER_PATHS.botCheckSecretFile');
    const containerfile = await read('Containerfile');
    expect(containerfile).not.toMatch(/COPY.*(?:turnstile-secret|cloudflared-token)/u);
    expect(await read('operator.public.env.example')).not.toMatch(/^(?:TUNNEL_TOKEN|TURNSTILE_SECRET|CLOUDFLARED_TOKEN)=/mu);
  });

  test('requires replacing the intentional digest placeholder before use', async () => {
    const overlay = await yaml('compose.public.yaml');
    expect(overlay.services.cloudflared.image).toContain('REPLACE_WITH_VERIFIED_CLOUDFLARED_DIGEST');
    expect(() => validateCloudflaredImage(overlay.services.cloudflared.image)).toThrow('replace the placeholder');
    for (const image of [undefined, '', 'cloudflare/cloudflared:latest', 'cloudflare/cloudflared:2026.1.0', 'cloudflare/cloudflared@sha256:invalid', `cloudflare/cloudflared@sha256:${'0'.repeat(64)}`]) {
      expect(() => validateCloudflaredImage(image)).toThrow();
    }
    // Syntax-only synthetic fixture, not a claimed real image digest.
    expect(() => validateCloudflaredImage(`cloudflare/cloudflared@sha256:${'a'.repeat(64)}`)).not.toThrow();
    expect(composeArguments('/operator/public.env')).toEqual(['compose', '--file', path.join(DEPLOY, 'compose.yaml'), '--file', path.join(DEPLOY, 'compose.public.yaml'), '--env-file', '/operator/public.env', '--profile', 'public']);
    expect(() => composeArguments('relative.env')).toThrow('absolute path');
    const script = await read('public-profile.js');
    expect(script).toContain("validateCloudflaredImage(resolved.services?.cloudflared?.image)");
    expect(script).toContain("'up', '--detach', '--no-build', '--pull', 'never'");
  });

  test('refuses placeholder startup before any up call and retains an immediate stop path (mock Docker)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'intake-public-wrapper-'));
    cleanup.push(root);
    const docker = path.join(root, 'docker');
    const log = path.join(root, 'calls');
    await writeFile(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_LOG"\nprintf \'%s\\n\' \'{"services":{"cloudflared":{"image":"cloudflare/cloudflared@sha256:REPLACE_WITH_VERIFIED_CLOUDFLARED_DIGEST"}}}\'\n', { mode: 0o700 });
    await chmod(docker, 0o700);
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, MOCK_LOG: log };
    const invoke = (action) => Bun.spawnSync({ cmd: [process.execPath, path.join(DEPLOY, 'public-profile.js'), action, '/synthetic/operator.env'], env, stdout: 'pipe', stderr: 'pipe' });
    const rejected = invoke('up');
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr.toString()).toContain('replace the placeholder');
    expect(await readFile(log, 'utf8')).toContain('config --format json');
    expect(await readFile(log, 'utf8')).not.toContain('up --detach');
    const stopped = invoke('stop');
    expect(stopped.exitCode).toBe(0);
    expect(await readFile(log, 'utf8')).toContain('stop cloudflared');
  });

  publicConfigTest('validates the public example through the real app loader and keeps limiter defaults', async () => {
    const appConfig = await import('../../../apps/account-free-intake/src/config.js');
    const config = await example();
    for (const [key, value] of Object.entries(appConfig.LAYERED_LIMIT_DEFAULTS)) expect(config.limits[key]).toBe(value);
    // Validate literal container paths first; then substitute only host fixture paths for loadConfig.
    const normalized = appConfig.validateConfig(config);
    expect(normalized.clientAddress).toEqual(config.clientAddress);
    expect(normalized.botCheck).toEqual(config.botCheck);
    const root = await mkdtemp(path.join(os.tmpdir(), 'intake-public-config-'));
    cleanup.push(root);
    config.bindingsRoot = path.join(root, 'bindings');
    config.gitDir = path.join(root, 'objects.git');
    config.queue.root = path.join(root, 'queue');
    config.botCheck.secretFile = path.join(root, 'synthetic-secret');
    await mkdir(config.bindingsRoot);
    await mkdir(config.gitDir);
    await writeFile(config.botCheck.secretFile, 'synthetic-unit-test-value-not-a-credential', { mode: 0o400 });
    const file = path.join(root, 'config.json');
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    await chmod(file, 0o600);
    const loaded = await appConfig.loadConfig(file);
    expect(loaded.botCheck.secretFile).toBe(config.botCheck.secretFile);
    expect(loaded.clientAddress.trustedPeers).toEqual(['172.30.93.0/29']);
    expect(loaded.limits.perSenderCapacity).toBe(3);
  });

  (dockerComposeAvailable ? test : test.skip)('renders real merged Compose with no default services and preserved hardening (CLI only, no daemon)', async () => {
    // Nonexistent file paths and synthetic digest: compose config never starts, pulls, or reads a secret.
    const env = {
      ...process.env,
      COMPOSE_PROFILES: '',
      ACCOUNT_FREE_INTAKE_IMAGE: `sha256:${'b'.repeat(64)}`,
      CLOUDFLARED_IMAGE: `cloudflare/cloudflared@sha256:${'a'.repeat(64)}`,
      ACCOUNT_FREE_INTAKE_CONFIG_PATH: '/nonexistent/public.json',
      ACCOUNT_FREE_INTAKE_BINDINGS_PATH: '/nonexistent/bindings',
      ACCOUNT_FREE_INTAKE_GIT_DIR: '/nonexistent/objects.git',
      ACCOUNT_FREE_INTAKE_NETWORK: 'synthetic-intake-internal',
      ACCOUNT_FREE_INTAKE_QUEUE_VOLUME: 'synthetic-intake-queue',
      ACCOUNT_FREE_INTAKE_TURNSTILE_SECRET_PATH: '/nonexistent/turnstile-secret',
      ACCOUNT_FREE_INTAKE_TUNNEL_TOKEN_PATH: '/nonexistent/tunnel-token',
    };
    const args = ['docker', 'compose', '--file', path.join(DEPLOY, 'compose.yaml'), '--file', path.join(DEPLOY, 'compose.public.yaml')];
    const render = (profile) => {
      const result = Bun.spawnSync({ cmd: [...args, ...profile, 'config', '--format', 'json'], env, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    expect(Object.keys(render([]).services ?? {})).toEqual([]);
    const config = render(['--profile', 'public']);
    expect(Object.keys(config.services).sort()).toEqual(['account-free-intake', 'account-free-intake-queue-init', 'cloudflared']);
    const intake = config.services['account-free-intake'];
    expect(intake.read_only).toBe(true);
    expect(intake.user).toBe('65532:65532');
    expect(intake.cap_drop).toEqual(['ALL']);
    expect(intake.security_opt).toEqual(['no-new-privileges:true']);
    expect(intake.ports).toBeUndefined();
    expect(config.services.cloudflared.ports).toBeUndefined();
    for (const target of ['/config/account-free-intake.json', '/srv/cyberbaser/source-bindings', '/srv/cyberbaser/source-objects.git']) {
      expect(intake.volumes.find((volume) => volume.target === target)?.read_only).toBe(true);
    }
    expect(config.networks['account-free-intake-internal'].internal).toBe(true);
    expect(config.networks['account-free-intake-internal'].ipam.config[0].subnet).toBe('172.30.93.0/29');
    validateCloudflaredImage(config.services.cloudflared.image);
  });

  test('documents public prerequisites, edge protection, shutdown, and explicit non-goals', async () => {
    const readme = await read('README.md');
    for (const text of ['Opening the form to the public (off by default)', '10 requests per 60 seconds', 'tunable', 'Cyberbaser-Challenge-Token', 'receipt status lookup', 'contributor accounts', 'stop /absolute/operator/', 'down /absolute/operator/', 'Turnstile', 'TrueNAS', 'not end-to-end encryption', 'outbound isolation']) expect(readme).toContain(text);
  });
});

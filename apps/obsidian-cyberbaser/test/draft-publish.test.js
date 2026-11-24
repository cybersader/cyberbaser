import { expect, test } from 'bun:test';
import { NodeError } from '../src/core/client.js';
import { createController, messageFor } from '../src/core/controller.js';
import { draftPublishPlan, withDraftOff } from '../src/core/new-page.js';

const PUBLISH_YML = 'allow:\n  - "topic/**"\n';
const NOTE = '---\ntitle: "A: b"\ndate: 2026-11-24\ndraft: true   # until it is ready\nfeatured: false\n---\r\n\nBody with draft: true in it.\n';

test('Draft off changes only that one value; every other byte stays', () => {
  expect(withDraftOff(NOTE)).toBe(NOTE.replace('draft: true   #', 'draft: false   #'));
  expect(withDraftOff('---\ndraft: yes\n---\n')).toBe('---\ndraft: false\n---\n');
  expect(withDraftOff('﻿---\ndraft: true\n---\nx')).toBe('﻿---\ndraft: false\n---\nx');
  // Nothing to change, or no single plain line to change.
  expect(withDraftOff('---\ntitle: x\n---\n')).toBeNull();
  expect(withDraftOff('---\ndraft: false\n---\n')).toBeNull();
  expect(withDraftOff('no frontmatter, draft: true\n')).toBeNull();
  expect(withDraftOff('---\ndraft: true\ndraft: true\n---\n')).toBeNull();
  expect(withDraftOff('---\nnested:\n  draft: true\n---\n')).toBeNull();
});

test('a draft publishes only where publish.yml would put it, and never with sample set', () => {
  expect(draftPublishPlan({ path: 'topic/n.md', text: NOTE, publishYml: PUBLISH_YML }))
    .toMatchObject({ status: { published: true, address: '/topic/n', draft: false } });
  expect(draftPublishPlan({ path: 'private/n.md', text: NOTE, publishYml: PUBLISH_YML })).toBeNull();
  expect(draftPublishPlan({ path: 'topic/n.md', text: '---\ndraft: true\nsample: true\n---\n', publishYml: PUBLISH_YML })).toBeNull();
  expect(draftPublishPlan({ path: 'topic/n.md', text: '---\ntitle: x\n---\n', publishYml: PUBLISH_YML })).toBeNull();
});

function node(reply) {
  const calls = [];
  const controller = createController({ client: { request: async (_p, command, input) => {
    calls.push([command, input]);
    if (reply instanceof Error) throw reply;
    return reply;
  } }, store: { load: async () => ({ keyId: 'k', grants: ['publish'] }) } });
  return { calls, controller };
}

test('Publish to your site: Draft off is inside the bytes sent (and signed), and the vault note follows', async () => {
  const { calls, controller } = node({ bundleId: 'b1', state: 'signing', publicAdditions: [{ path: 'topic/n.md', address: '/topic/n' }] });
  const written = [];
  const outcome = await controller.publishDraft({ path: 'topic/n.md' }, NOTE, { publishYml: PUBLISH_YML, writeBack: async (text) => written.push(text) });
  expect(outcome).toMatchObject({ kind: 'publishing', address: '/topic/n' });
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('submitPageBundle');
  expect(calls[0][1].main.text).toBe(withDraftOff(NOTE));
  expect(written).toEqual([withDraftOff(NOTE)]);
});

test('if the node refuses, the vault note stays a draft', async () => {
  const { controller } = node(new NodeError('refused', 'create-path-exists'));
  const written = [];
  await expect(controller.publishDraft({ path: 'topic/n.md' }, NOTE, { publishYml: PUBLISH_YML, writeBack: async (text) => written.push(text) }))
    .rejects.toMatchObject({ reason: 'create-path-exists' });
  expect(written).toEqual([]);
});

test('a draft that cannot be turned off here, or would not be public, is refused before anything is sent', async () => {
  const { calls, controller } = node({});
  const odd = '---\ndraft: "true"\n---\n';
  await expect(controller.publishDraft({ path: 'topic/n.md' }, odd, { publishYml: PUBLISH_YML })).rejects.toMatchObject({ reason: 'draft-not-plain' });
  await expect(controller.publishDraft({ path: 'private/n.md' }, NOTE, { publishYml: PUBLISH_YML }))
    .rejects.toMatchObject({ reason: 'create-outside-publication' });
  expect(calls).toEqual([]);
  expect(messageFor(new NodeError('refused', 'draft-not-plain'))).toContain('Turn Draft off in its properties');
});

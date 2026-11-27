import { expect, test } from 'bun:test';
import { NodeError } from '../src/core/client.js';
import { createController, messageFor } from '../src/core/controller.js';
import { draftPublishPlan, withDraftOff, withFirstPublishDates } from '../src/core/new-page.js';

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

test('first-publish date: only the empty date line gets the date; every other byte stays', () => {
  const note = '---\ntitle: "A: b"\ndate:\ndraft: true\n---\n\ndate: in the body stays\n';
  expect(withFirstPublishDates(note, { date: '2026-11-24' })).toBe(note.replace('date:\ndraft', 'date: 2026-11-24\ndraft'));
  expect(withFirstPublishDates('---\ndate:   # set on publish\n---\n', { date: '2026-11-24' })).toBe('---\ndate: 2026-11-24 # set on publish\n---\n');
  // Already dated, not plain, missing, or not a date: unchanged.
  for (const text of ['---\ndate: 2026-01-02\n---\n', '---\ndate: ""\n---\n', '---\ntitle: x\n---\n', '---\ndate:\ndate:\n---\n',
    '---\nnested:\n  date:\n---\n', 'no frontmatter\ndate:\n']) {
    expect(withFirstPublishDates(text, { date: '2026-11-24' })).toBe(text);
  }
  expect(withFirstPublishDates('---\ndate:\n---\n', { date: '2026-11-24\nx: 1' })).toBe('---\ndate:\n---\n');
  expect(withFirstPublishDates('---\ndate:\n---\n', {})).toBe('---\ndate:\n---\n');
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

test('Publish fills the first-publish date inside the signed bytes, with Draft off; nothing else changes', async () => {
  const { calls, controller } = node({ bundleId: 'b2', state: 'signing', publicAdditions: [{ path: 'topic/n.md', address: '/topic/n' }] });
  const note = '---\ntitle: New\ndate:\ndraft: true\n---\n\nText.\n';
  const written = [];
  await controller.publishDraft({ path: 'topic/n.md' }, note, { publishYml: PUBLISH_YML, stamps: { date: '2026-11-24' }, writeBack: async (text) => written.push(text) });
  const sent = '---\ntitle: New\ndate: 2026-11-24\ndraft: false\n---\n\nText.\n';
  expect(calls[0][1].main.text).toBe(sent);
  expect(written).toEqual([sent]);
  // A note that is not a draft (Publish new page) gets its date the same way.
  const second = node({ bundleId: 'b3', state: 'signing', publicAdditions: [] });
  const later = [];
  const open = '---\ntitle: New\ndate:\ndraft: false\n---\n';
  await second.controller.publishNewPage({ path: 'topic/m.md' }, open, { status: { published: true, draft: false, address: '/topic/m' },
    stamps: { date: '2026-11-24' }, writeBack: async (text) => later.push(text) });
  expect(second.calls[0][1].main.text).toBe(open.replace('date:', 'date: 2026-11-24'));
  expect(later).toEqual([open.replace('date:', 'date: 2026-11-24')]);
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

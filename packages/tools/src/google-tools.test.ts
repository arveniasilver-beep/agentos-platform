import { describe, it, expect } from 'vitest';
import { createGoogleTools, type GoogleToolApi } from './index';

const api: GoogleToolApi = {
  listEvents: async (since) => ({ events: [{ summary: `from:${since}`, start: 's', end: 'e' }] }),
  searchDrive: async (query) => ({ files: [{ id: 'f', name: query, mimeType: 'm', link: 'l' }] }),
  searchGmail: async (query) => ({ messages: [{ id: 'm1', from: 'a@b', subject: query, date: 'd', snippet: 'sn' }] }),
};

describe('google tools', () => {
  it('registers calendar + drive + gmail tools', () => {
    expect(createGoogleTools(api).map((t) => t.definition.id).sort()).toEqual([
      'gmail_search',
      'google_calendar_events',
      'google_drive_search',
    ]);
  });

  it('delegates to the host api', async () => {
    const tools = createGoogleTools(api);
    const cal = tools.find((t) => t.definition.id === 'google_calendar_events')!;
    const drive = tools.find((t) => t.definition.id === 'google_drive_search')!;
    const gmail = tools.find((t) => t.definition.id === 'gmail_search')!;
    expect(await cal.run({ since: '2026-06-20T00:00:00Z' })).toEqual({
      events: [{ summary: 'from:2026-06-20T00:00:00Z', start: 's', end: 'e' }],
    });
    expect(await drive.run({ query: 'budget' })).toEqual({ files: [{ id: 'f', name: 'budget', mimeType: 'm', link: 'l' }] });
    expect(await gmail.run({ query: 'invoice' })).toEqual({
      messages: [{ id: 'm1', from: 'a@b', subject: 'invoice', date: 'd', snippet: 'sn' }],
    });
  });
});

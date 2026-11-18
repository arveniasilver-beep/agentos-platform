/**
 * Capability modes (Manus-style): a task can be created in a mode that primes the agent to produce a
 * specific kind of deliverable. The mode list and its display metadata are shared between the web UI
 * (which renders the mode chips) and the API (which maps each mode to a system prompt). Only modes we
 * can ACTUALLY deliver end-to-end are listed — no placeholder modes for outputs that would require an
 * external generation model we don't have.
 */

export const TASK_CAPABILITIES = [
  'general',
  'chat',
  'slides',
  'document',
  'website',
  'spreadsheet',
  'chart',
  'visualization',
  'image',
  'audio',
] as const;

export type TaskCapability = (typeof TASK_CAPABILITIES)[number];

export interface CapabilityMeta {
  id: TaskCapability;
  /** Short label for the mode chip. */
  label: string;
  /** One-line description of what this mode produces. */
  description: string;
  /** Lightweight icon hint the UI maps to a glyph (kept framework-agnostic in the protocol). */
  icon: string;
}

export const CAPABILITY_META: Record<TaskCapability, CapabilityMeta> = {
  general: {
    id: 'general',
    label: 'Agent',
    description: 'Full autonomous agent — plans, uses every tool, and works the task end to end.',
    icon: 'sparkles',
  },
  chat: {
    id: 'chat',
    label: 'Chat',
    description: 'Quick conversational answer with no tools or sandbox — fast Q&A.',
    icon: 'chat',
  },
  slides: {
    id: 'slides',
    label: 'Slides',
    description: 'Build a navigable presentation deck as a downloadable HTML file.',
    icon: 'presentation',
  },
  document: {
    id: 'document',
    label: 'Document',
    description: 'Write a polished report or article as print-ready HTML + Markdown.',
    icon: 'document',
  },
  website: {
    id: 'website',
    label: 'Website',
    description: 'Generate a multi-page static website with shared styling and navigation.',
    icon: 'globe',
  },
  spreadsheet: {
    id: 'spreadsheet',
    label: 'Spreadsheet',
    description: 'Produce tabular data as CSV (opens in Excel/Sheets) with an HTML preview.',
    icon: 'table',
  },
  chart: {
    id: 'chart',
    label: 'Chart',
    description: 'Visualize data as a clean bar, line, or pie chart (SVG).',
    icon: 'chart',
  },
  visualization: {
    id: 'visualization',
    label: 'Visualization',
    description: 'Turn data into a multi-chart visual report — several charts plus an analytic narrative.',
    icon: 'chart',
  },
  image: {
    id: 'image',
    label: 'Image',
    description: 'Generate an image from a description (requires a configured image provider).',
    icon: 'image',
  },
  audio: {
    id: 'audio',
    label: 'Audio',
    description: 'Synthesize speech audio from text (requires a configured speech provider).',
    icon: 'audio',
  },
};

/** Narrowing guard for untrusted input (query params, request bodies). */
export function isTaskCapability(value: unknown): value is TaskCapability {
  return typeof value === 'string' && (TASK_CAPABILITIES as readonly string[]).includes(value);
}

import { type TaskCapability } from '@agentos/protocol';
import { PLAN_TRACKING_NUDGE } from '@agentos/agent-engine';

/**
 * Server-side mapping from a task's capability mode to how the engine should run it. Each mode tunes
 * the system prompt (and, for chat, disables the plan phase + tools) so the same agent loop produces
 * the right kind of deliverable. Keeping the prompts here (not in the shared protocol) keeps the
 * model-steering server-only.
 */
export interface CapabilityRunConfig {
  /** System prompt for the act loop, or undefined to use the engine default (general mode). */
  system?: string;
  /** Skip the planning phase (chat = a single conversational turn). */
  skipPlanning?: boolean;
  /** Provision no tools for this run (chat = pure Q&A, no sandbox/network/files). */
  disableTools?: boolean;
}

const AGENT_BASE =
  "You are an autonomous agent. Use the available tools to accomplish the user's task. " +
  'Call a tool when you need it; when the task is complete, respond with the final answer and stop.';

/** Compose the base agent instruction with a deliverable-specific directive + plan-tracking nudge. */
function deliverable(directive: string): string {
  return `${AGENT_BASE}\n\n${directive}\n\n${PLAN_TRACKING_NUDGE}`;
}

const CONFIGS: Record<TaskCapability, CapabilityRunConfig> = {
  general: {},
  chat: {
    system:
      'You are a helpful, knowledgeable assistant. Answer the question directly, accurately, and ' +
      'concisely in prose. You have no tools, file system, or internet access in this mode — do not ' +
      'claim to perform actions or cite live data; give the best answer from your own knowledge, and ' +
      'say so if something is outside it.',
    skipPlanning: true,
    disableTools: true,
  },
  slides: {
    system: deliverable(
      'The user wants a SLIDE DECK. Plan the narrative, then call generate_slides EXACTLY ONCE with a ' +
        'complete, well-structured deck: a clear title, 5-15 focused slides, concise bullets (not walls ' +
        'of text), and a logical flow. After it returns, tell the user the deck is ready and give the ' +
        'artifact path.',
    ),
  },
  document: {
    system: deliverable(
      'The user wants a DOCUMENT or REPORT. Plan the structure, then call generate_document EXACTLY ONCE ' +
        'with a polished, well-organized piece: a descriptive title and logically ordered sections with ' +
        'clear headings, substantive paragraphs, and bullet lists where they help. Then give the user ' +
        'the artifact paths.',
    ),
  },
  website: {
    system: deliverable(
      'The user wants a WEBSITE. Plan the pages and content, then call generate_website EXACTLY ONCE with ' +
        'a coherent multi-page static site: a sensible page set (e.g. Home plus a few sections), clear ' +
        'copy, and consistent structure. Then give the user the entry index.html path.',
    ),
  },
  spreadsheet: {
    system: deliverable(
      'The user wants a SPREADSHEET or dataset. Determine the data (gather it with your tools if needed), ' +
        'then call generate_spreadsheet EXACTLY ONCE with well-structured sheets: clear column headers ' +
        'and clean, consistent rows. Then give the user the CSV artifact paths.',
    ),
  },
  chart: {
    system: deliverable(
      'The user wants a CHART. Determine the data and the most appropriate chart type (bar, line, or ' +
        'pie), then call generate_chart EXACTLY ONCE with a descriptive title and labelled data points. ' +
        'Then give the user the artifact path.',
    ),
  },
  visualization: {
    system: deliverable(
      'The user wants a DATA VISUALIZATION / dashboard. Gather the needed data (use your tools if ' +
        'required), then call generate_chart MULTIPLE times — one call per distinct view (e.g. a trend ' +
        'line, a breakdown bar, a composition pie) — choosing the right chart type each time. Then call ' +
        'generate_document ONCE to assemble an analytic report whose sections reference the charts and ' +
        'explain the insights. Finally give the user all the artifact paths.',
    ),
  },
  image: {
    system: deliverable(
      'The user wants an IMAGE. Craft a vivid, specific prompt, then call generate_image with it (pick ' +
        'a sensible size). If the tool is unavailable, tell the user to configure an image provider in ' +
        'Settings → Media. Then give the user the artifact path.',
    ),
  },
  audio: {
    system: deliverable(
      'The user wants AUDIO (speech). Prepare the text to read, then call generate_speech with it. If ' +
        'the tool is unavailable, tell the user to configure a speech provider in Settings → Media. Then ' +
        'give the user the artifact path.',
    ),
  },
};

/** Resolve the run config for a capability; unknown/null capabilities fall back to general mode. */
export function capabilityConfig(capability: string | null | undefined): CapabilityRunConfig {
  if (capability && capability in CONFIGS) {
    return CONFIGS[capability as TaskCapability];
  }
  return CONFIGS.general;
}

import type { TaskCapability } from '@agentos/protocol';

/**
 * Marketplace: a curated catalog of high-quality starter playbooks (Manus-style template gallery).
 * These are static, ship with the app, and are cloned into a workspace on demand — so there is NO
 * cross-tenant read and no new RLS surface. Templates use {{variable}} placeholders, which plug into
 * the parameterized-playbook fill flow at run time.
 */
export interface PlaybookTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  prompt: string;
  capability?: TaskCapability;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export const TEMPLATE_CATEGORIES = ['Research', 'Content', 'Coding', 'Data', 'Productivity'] as const;

export const PLAYBOOK_TEMPLATES: PlaybookTemplate[] = [
  {
    id: 'deep-research-report',
    name: 'Deep research report',
    description: 'Multi-source, fact-checked report on any topic with citations.',
    category: 'Research',
    capability: 'document',
    effort: 'high',
    prompt:
      'Write a thorough, well-structured research report on {{topic}} for a {{audience}} audience. ' +
      'Use multiple independent sources, verify key claims, compare differing viewpoints, and cite every ' +
      'source. End with a concise executive summary and a list of open questions.',
  },
  {
    id: 'competitive-analysis',
    name: 'Competitive analysis',
    description: 'Compare a product against its top competitors across key dimensions.',
    category: 'Research',
    capability: 'document',
    effort: 'high',
    prompt:
      'Produce a competitive analysis of {{product}} versus its top competitors. Compare pricing, core ' +
      'features, target users, strengths and weaknesses in a table, then recommend where {{product}} ' +
      'should focus to win. Cite sources.',
  },
  {
    id: 'market-sizing',
    name: 'Market sizing (TAM/SAM/SOM)',
    description: 'Estimate the addressable market for an idea with stated assumptions.',
    category: 'Research',
    capability: 'document',
    effort: 'high',
    prompt:
      'Estimate the TAM, SAM and SOM for {{idea}} in {{region}}. Show every assumption and the math, ' +
      'use a top-down and a bottom-up estimate, and flag the biggest sources of uncertainty.',
  },
  {
    id: 'blog-post',
    name: 'SEO blog post',
    description: 'A structured, search-friendly article on a chosen keyword.',
    category: 'Content',
    capability: 'general',
    effort: 'medium',
    prompt:
      'Write an engaging, well-structured blog post targeting the keyword "{{keyword}}". Include an H1, ' +
      'clear H2/H3 sections, a short intro and conclusion, and a meta description under 160 characters. ' +
      'Tone: {{tone}}.',
  },
  {
    id: 'social-thread',
    name: 'Social media thread',
    description: 'Turn an idea into a punchy multi-post thread.',
    category: 'Content',
    capability: 'general',
    effort: 'low',
    prompt:
      'Turn this idea into a punchy {{count}}-post thread for {{platform}}: {{idea}}. Hook hard on the ' +
      'first post, one idea per post, and end with a clear call to action.',
  },
  {
    id: 'code-review',
    name: 'Code review checklist',
    description: 'Review a snippet for bugs, security and clarity.',
    category: 'Coding',
    capability: 'general',
    effort: 'high',
    prompt:
      'Review the following code for correctness bugs, security issues, edge cases and readability, then ' +
      'give concrete suggested fixes ordered by severity:\n\n{{code}}',
  },
  {
    id: 'explain-codebase',
    name: 'Explain a repository',
    description: 'A guided tour of an unfamiliar codebase.',
    category: 'Coding',
    capability: 'general',
    effort: 'high',
    prompt:
      'Explore the repository at {{repo_url}} and explain its architecture: the main modules, how data ' +
      'flows, the key entry points, and how to run it locally. Finish with the 3 files a new contributor ' +
      'should read first.',
  },
  {
    id: 'data-cleanup',
    name: 'Clean & summarize a dataset',
    description: 'Tidy a messy spreadsheet and surface insights.',
    category: 'Data',
    capability: 'spreadsheet',
    effort: 'medium',
    prompt:
      'Clean the attached dataset about {{subject}}: fix obvious errors, normalize columns, and then ' +
      'summarize the 5 most interesting insights with simple charts.',
  },
  {
    id: 'weekly-plan',
    name: 'Weekly plan from goals',
    description: 'Turn goals into a realistic week-by-day plan.',
    category: 'Productivity',
    capability: 'general',
    effort: 'low',
    prompt:
      'I want to achieve these goals this week: {{goals}}. Build a realistic day-by-day plan that fits ' +
      'about {{hours_per_day}} focused hours per day, with the highest-leverage tasks first.',
  },
  {
    id: 'trip-itinerary',
    name: 'Trip itinerary',
    description: 'A day-by-day travel plan tailored to your interests.',
    category: 'Productivity',
    capability: 'document',
    effort: 'medium',
    prompt:
      'Plan a {{days}}-day trip to {{destination}} for someone interested in {{interests}}. Give a ' +
      'day-by-day itinerary with timing, rough costs, and a few local food recommendations.',
  },
];

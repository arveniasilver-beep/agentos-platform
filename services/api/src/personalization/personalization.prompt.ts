/** The persisted personalization shape the preamble builder consumes (DB row or defaults). */
export interface PersonalizationData {
  nickname?: string | null;
  profession?: string | null;
  about?: string | null;
  instructions?: string | null;
  memories?: string[];
}

/**
 * Compose the always-on system-prompt preamble from a workspace's personalization (Manus-style
 * "Kişiselleştirme"). Prepended to every task's system prompt so the agent is steered consistently.
 * Returns undefined when nothing is set, so the engine falls back to the plain system prompt. Pure
 * (no I/O) for easy unit testing. Each field is already length-capped at the DTO layer; we also trim
 * here and skip empty sections so a half-filled profile doesn't add noise.
 */
export function composePersonalizationPreamble(p: PersonalizationData): string | undefined {
  const profile: string[] = [];
  if (p.nickname?.trim()) profile.push(`- Name / how to address them: ${p.nickname.trim()}`);
  if (p.profession?.trim()) profile.push(`- Profession: ${p.profession.trim()}`);
  if (p.about?.trim()) profile.push(`- About them: ${p.about.trim()}`);

  const facts = (p.memories ?? []).map((m) => m.trim()).filter(Boolean);
  const instructions = p.instructions?.trim();

  const sections: string[] = [];
  if (profile.length) sections.push(`About the user you are assisting:\n${profile.join('\n')}`);
  if (instructions) sections.push(`The user's custom instructions (follow them):\n${instructions}`);
  if (facts.length) {
    sections.push(`Facts to remember about the user/workspace:\n${facts.map((f) => `- ${f}`).join('\n')}`);
  }

  if (!sections.length) return undefined;
  return (
    'Persistent context about the user and how they want you to work — honor it throughout the task:\n\n' +
    sections.join('\n\n')
  );
}

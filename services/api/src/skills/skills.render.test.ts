import { describe, it, expect } from 'vitest';
import { SkillsService } from './skills.service';

describe('SkillsService.renderPrompt', () => {
  it('substitutes every {{input}} placeholder', () => {
    expect(SkillsService.renderPrompt('Summarize {{input}} in 3 bullets.', 'https://x.com')).toBe(
      'Summarize https://x.com in 3 bullets.',
    );
    expect(SkillsService.renderPrompt('{{input}} then {{input}}', 'X')).toBe('X then X');
  });

  it('appends the input when there is no placeholder', () => {
    expect(SkillsService.renderPrompt('Do the thing.', 'with this data')).toBe(
      'Do the thing.\n\nwith this data',
    );
  });

  it('leaves the template unchanged when no input is given and there is no placeholder', () => {
    expect(SkillsService.renderPrompt('Just do it.')).toBe('Just do it.');
  });

  it('drops the placeholder when input is empty', () => {
    expect(SkillsService.renderPrompt('A {{input}} B', '')).toBe('A  B');
  });
});

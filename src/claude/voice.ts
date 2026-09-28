import { normalizePath, type App, type TFile } from "obsidian";

/** The user's voice profile (spec §2.5), read by the /social skill before drafting. */
export const VOICE_FILE = "_voice.md";

export const VOICE_TEMPLATE = `# Voice profile

Claude reads this note before drafting posts (the /social skill). Keep it short and concrete, and replace the examples in brackets with your own.

## Who I am and who I write for
- I am: [one line: your role, your project, what you make]
- Audience: [who reads you and what they care about]

## Tone
- [e.g. Direct and warm. Short sentences. First person.]

## Do
- [e.g. Lead with the concrete result or number.]
- [e.g. One idea per post.]

## Don't
- [e.g. No hype words: "game-changer", "revolutionary", "excited to announce".]
- [e.g. At most two hashtags.]

## Vocabulary
- Words I use: [ ]
- Words I avoid: [ ]
- Spelling and style: [e.g. British English, sentence-case headings, numerals for 10 and up]

## Per platform
- LinkedIn: [ ]
- X: [ ]
- Mastodon and Bluesky: [ ]

## Example posts
Paste two to five posts that sound like you, each under its own heading.

### Example 1
[post text]

## Refinements
Claude adds dated notes here when you ask it to learn from your published posts. Edit or delete them freely.
`;

export function voicePath(root: string): string {
  return normalizePath(`${root}/${VOICE_FILE}`);
}

/** Creates `<root>/_voice.md` from the template unless it exists; never overwrites the user's profile. */
export async function createVoiceProfile(app: App, root: string): Promise<{ file: TFile; created: boolean }> {
  const path = voicePath(root);
  const existing = app.vault.getFileByPath(path);
  if (existing) return { file: existing, created: false };
  const folder = normalizePath(root);
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  return { file: await app.vault.create(path, VOICE_TEMPLATE), created: true };
}

# Voice profile

The user's voice lives in `Social/_voice.md` (`get_voice_profile`). Read it before drafting and, with each draft, name the rules you applied ("Voice: no hype words, first person, one idea per post").

## When there is none
Offer to create it: the user runs **Create voice profile** in Obsidian (command palette, or Settings → Social Planner → Claude Code → Voice profile), which writes this template. Then fill it in together: ask about audience, tone, words they like and avoid, and ask for two to five posts they are proud of. Offline, write the file yourself from the template.

## Template

````markdown
# Voice profile

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
````

## Refining the voice from published posts
1. `list_posts` with `status: ["published"]` (per platform if the user wants), then `get_post` for up to ten of them; `get_log` shows which went out and where.
2. Compare them with the profile: what do the posts that worked have in common (openings, length, structure, words)? What contradicts the profile?
3. Propose three to five concrete rules, each with the post that shows it. No vague rules ("be engaging").
4. Only after the user agrees to the exact wording, `add_voice_refinement` with those rules as a list. Never rewrite the user's own sections; suggest edits and let them make them.

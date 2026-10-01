import { blueskyCase } from "../bluesky/contract";
import { discordCase } from "../discord/contract";
import { facebookCase } from "../facebook/contract";
import { instagramCase } from "../instagram/contract";
import { mastodonCase } from "../mastodon/contract";
import { telegramCase } from "../telegram/contract";
import { wordpressCase } from "../wordpress/contract";
import { xCase } from "../x/contract";
import type { ContractCase } from "./harness";

/** One case per registered API adapter; contract.test.ts fails when createAdapters() has a platform missing here. */
export const CASES: ContractCase[] = [
  telegramCase,
  discordCase,
  blueskyCase,
  mastodonCase,
  wordpressCase,
  xCase,
  facebookCase,
  instagramCase,
];

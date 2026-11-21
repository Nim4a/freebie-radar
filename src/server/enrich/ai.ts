import {
  aiReady,
  DEFAULT_PROMPT,
  feedbackStats,
  getAiSettings,
  matchesEntryNoise,
  publicAiSettings,
  reviewItems,
  saveAiSettings,
  shouldPassSourceToAi,
  testAiConnection,
  type AiSettings,
  type AiSourceMode,
  type AiVerdict,
} from "./ai-settings.ts";

export type { AiVerdict, AiSettings, AiSourceMode };
export {
  reviewItems,
  aiReady,
  getAiSettings,
  saveAiSettings,
  publicAiSettings,
  testAiConnection,
  feedbackStats,
  matchesEntryNoise,
  shouldPassSourceToAi,
  DEFAULT_PROMPT,
};

/** Collector-side check: whether an item should be submitted for review (reads the DB switch, so config changes take effect immediately). */
export function shouldReview(): boolean {
  return aiReady();
}

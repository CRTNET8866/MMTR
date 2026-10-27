/* ============================================================================
 * MMTR · MMTR —— 公共入口
 * ==========================================================================*/

export { MMTR } from './engine.ts';
export type { MMTROptions, SleepResult, ExplainResult } from './engine.ts';

export { loadConfig, DEFAULT_CONFIG } from './config.ts';
export type { MMTRConfig, ChannelConfig, FestivalDef, ResolvedConfig } from './config.ts';

export * from './types.ts';

export { assembleContext } from './retrieve.ts';
export type { RetrieveOptions, AssembleOptions } from './retrieve.ts';
export { consolidate, compressOne } from './consolidate.ts';
export type { ConsolidateOptions } from './consolidate.ts';

export { computeWeights, floorLevelForImportance, timelineLabel, strengthLabel } from './decay.ts';
export { matchAnchor, describeAnchor } from './calendar.ts';
export { relationFeeling, relationNumberLine, affectMoodLine } from './relation.ts';
export { createEmbeddingProvider, LocalEmbeddingProvider, HttpEmbeddingProvider } from './embeddings.ts';
export { createBrain, HeuristicBrain, LLMBrain, ChatClient } from './llm.ts';
export type { Brain } from './llm.ts';
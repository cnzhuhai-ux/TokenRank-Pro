/**
 * token 维度明细的上报上限：models / tools / tool_models 按日尽量全量，
 * 仍保留防滥用上限；credits 分项沿用各自的小上限，不在这里定义。
 */
export const TOKEN_DETAIL_LIMITS = Object.freeze({ models: 1024, tools: 128, tool_models: 1024 });

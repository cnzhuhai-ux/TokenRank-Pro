/**
 * 模型名归一（榜单合并用）。
 *
 * Trae 自定义模型（BYOK）上报为 `[Provider] 模型名`，内置模型上报为原值；同一模型可能
 * 因此出现两条（`GLM-5.3` 与 `[bigmodel-plan] GLM-5.3`），另有大小写差异（`glm-5.3`）。
 * 榜单按 modelKey 合并成一条，展示名按 pickDisplay 稳定选择，上报侧不改写原样。
 *
 * 只用于模型维度：工具名不做归一，`DSH For OortCloud Work` 与 `dsh ...` 属不同上报口径。
 */
const PREFIX = /^\[[^\]]{1,20}\]\s+/;

/** 榜单聚合键：去 [Provider] 前缀 → trim → 小写 → 空白折叠。 */
export function modelKey(label) {
  return String(label || '')
    .replace(PREFIX, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** 是否为自定义模型上报名（带 `[Provider] ` 前缀）。 */
export function isCustomLabel(label) {
  return PREFIX.test(String(label || ''));
}

/** 展示名选择：无前缀（内置）的原写法优先，否则保留先到者，保证结果不随行序抖动。 */
export function pickDisplay(current, candidate) {
  if (!current) return candidate;
  if (isCustomLabel(current) && !isCustomLabel(candidate)) return candidate;
  return current;
}

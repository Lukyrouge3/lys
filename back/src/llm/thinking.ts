/**
 * CLIProxyAPI reads a thinking budget from a suffix on the model name, in
 * parentheses after the model: `claude-haiku-5-5(low)`, `(...)(2048)`,
 * `(...)(none)`. The proxy strips it before routing. A model that already
 * carries a suffix is left alone, so a configured name wins over the env knob.
 */
export function withThinking(model: string, thinking?: string): string {
  const level = thinking?.trim();
  if (!level) return model;
  if (model.endsWith(")")) return model;
  return `${model}(${level})`;
}

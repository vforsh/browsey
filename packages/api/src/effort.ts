import type { AgentEffortOption } from '@vforsh/browsey-shared'

/**
 * Naming for reasoning levels, shared by both agents' catalogues.
 *
 * The ids are the CLIs' own and are passed through untouched; only the casing
 * shown on a chip is decided here, so that `xhigh` does not read as "Xhigh" in
 * one row and "XHigh" in the other.
 */
const LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
}

export function effortLabel(id: string): string {
  return LABELS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`
}

export function effortOption(id: string, description?: string): AgentEffortOption {
  return { id, label: effortLabel(id), ...(description ? { description } : {}) }
}
